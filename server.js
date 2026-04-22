const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const cors = require('cors');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const rooms = {};

app.post('/api/ask-judge', async (req, res) => {
    const { category, letter, answer } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `אתה שופט חכם והוגן במשחק "ארץ עיר".
        הקטגוריה: "${category}", האות: "${letter}", התשובה שהשחקן כתב: "${answer}".
        עליך להחליט האם לאשר את התשובה לפי הכללים הבאים:
        1. התשובה חייבת להתחיל באות הנכונה "${letter}". אם לא - פסול.
        2. פסול לחלוטין מילים שהן ג'יבריש ברור או שורת אותיות חסרת משמעות.
        3. מותרת שגיאת כתיב של אות אחת (בתנאי שזו לא האות הראשונה).
        4. התעלם מעודף או חוסר באותיות 'א' ו-'י' (אשר את המילה גם אם חסר או נוסף א/י).
        5. אם המילה קשורה לנושא ויש סיכוי טוב שהיא עונה להגדרה - אשר.
        6. בקטגוריות "שם של בן" או "שם של בת" - אשר שמות לועזיים אם הם נפוצים בחו"ל.
        7. בקטגוריות "איבר גוף", "צומח", ו"מאכל" - אשר אם נכתב השם המדעי או הלועזי המקובל.

        החזר אך ורק JSON תקין (ללא טקסט נוסף) במבנה:
        {"isValid": true/false, "reason": "הסבר קצר"}`;
        
        const resultPromise = model.generateContent(prompt);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
        
        const response = await Promise.race([resultPromise, timeoutPromise]);
        let text = response.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (e) {
        res.json({ isValid: true, reason: "אושר מחמת הספק" });
    }
});

function calculateAndSendResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    const minTime = Math.min(...room.players.filter(p => p.time < 999).map(p => p.time));
    
    room.players.forEach(p => {
        let score = p.correctCount * 10;
        if (minTime > 0 && minTime !== Infinity && p.time < 999) {
            const excessRatio = (p.time - minTime) / minTime;
            if (excessRatio > 0.50) {
                const penalties = Math.floor(excessRatio / 0.10);
                score -= (penalties * 5);
            }
        }
        p.finalScore = Math.max(0, score);
    });

    room.players.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        return a.time - b.time;
    });

    io.to(roomId).emit('gameOver', room.players);
    // הסרנו את מחיקת החדר כדי שאפשר יהיה לשחק שוב!
}

io.on('connection', (socket) => {
    socket.on('createRoom', (hostName) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const gameLetter = letters[Math.floor(Math.random() * letters.length)];
        
        rooms[roomId] = { players: [], letter: gameLetter, submittedCount: 0, gameStarted: false };
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, name: hostName, isHost: true, hasSubmitted: false });
        
        socket.emit('roomCreated', { roomId, letter: gameLetter, players: rooms[roomId].players });
    });

    socket.on('joinRoom', ({ roomId, playerName, isHostClaim }) => {
        let room = rooms[roomId];
        if (!room) {
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            const gameLetter = letters[Math.floor(Math.random() * letters.length)];
            rooms[roomId] = { players: [], letter: gameLetter, submittedCount: 0, gameStarted: false };
            room = rooms[roomId];
        }

        const existingPlayer = room.players.find(p => p.name === playerName);
        if (existingPlayer) {
            existingPlayer.id = socket.id; 
            if (isHostClaim) existingPlayer.isHost = true;
        } else {
            const hasHost = room.players.some(p => p.isHost);
            room.players.push({ id: socket.id, name: playerName, isHost: isHostClaim || !hasHost, hasSubmitted: false });
        }
        
        socket.join(roomId);
        socket.emit('roomJoined', { roomId, letter: room.letter, isHost: room.players.find(p=>p.name===playerName).isHost });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (roomId) => {
        if(rooms[roomId]) {
            rooms[roomId].gameStarted = true;
            io.to(roomId).emit('gameStarted', rooms[roomId].letter);
        }
    });

    // הכרזה מיידית ששחקן לחץ סיימתי
    socket.on('announceFinish', ({ roomId, playerName }) => {
        io.to(roomId).emit('playerAnnouncedFinish', playerName);
    });

    socket.on('submitScore', ({ roomId, correctCount, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) {
            player.correctCount = correctCount;
            player.time = timeInSeconds;
            player.answers = answers;
            player.hasSubmitted = true;
            room.submittedCount++;
        }

        if (room.submittedCount >= room.players.length) {
            calculateAndSendResults(roomId);
        }
    });

    socket.on('forceEndGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && player.isHost) {
            room.players.forEach(p => {
                if (!p.hasSubmitted) {
                    p.hasSubmitted = true;
                    p.correctCount = 0;
                    p.time = 999;
                    p.answers = {};
                }
            });
            room.submittedCount = room.players.length;
            calculateAndSendResults(roomId);
        }
    });

    // חזרה ללובי למשחק נוסף באותו חדר
    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.gameStarted = false;
            room.submittedCount = 0;
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            
            room.players.forEach(p => {
                p.hasSubmitted = false;
                p.correctCount = 0;
                p.time = 0;
                p.answers = {};
                p.finalScore = 0;
            });
            
            socket.emit('returnToLobby', { letter: room.letter, players: room.players });
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                if (!room.gameStarted) {
                    room.players.splice(playerIndex, 1);
                    io.to(roomId).emit('updatePlayers', room.players);
                } else {
                    // אם המשחק התחיל והוא התנתק, מחכים 2 דקות
                    setTimeout(() => {
                        if (rooms[roomId] && !room.players[playerIndex].hasSubmitted) {
                            room.players[playerIndex].hasSubmitted = true;
                            room.players[playerIndex].correctCount = 0;
                            room.players[playerIndex].time = 999;
                            room.players[playerIndex].answers = {};
                            rooms[roomId].submittedCount++;
                            if (rooms[roomId].submittedCount >= rooms[roomId].players.length) calculateAndSendResults(roomId);
                        }
                    }, 120000);
                }
            }
            
            // מחיקת חדר רק אם כולם יצאו לגמרי
            if(room.players.length === 0) delete rooms[roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running'));
