const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const rooms = {};

// שופט ג'מיני בגישה מקלה
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
        {"isValid": true/false, "reason": "הסבר קצר של 2-3 מילים"}`;
        
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000));
        const resultPromise = model.generateContent(prompt);
        const response = await Promise.race([resultPromise, timeoutPromise]);
        
        if (response.timeout) return res.json({ isValid: true, reason: "אושר (השופט איטי)" });

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
    setTimeout(() => { delete rooms[roomId]; }, 10000);
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

    socket.on('submitScore', ({ roomId, correctCount, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('gameError', 'השרת התאפס והחדר אבד. רעננו את הדף והתחילו משחק חדש.');
            return;
        }
        
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) {
            player.correctCount = correctCount;
            player.time = timeInSeconds;
            player.answers = answers;
            player.hasSubmitted = true;
            room.submittedCount++;
        }

        if (room.submittedCount === room.players.length) {
            calculateAndSendResults(roomId);
        }
    });
    
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                if (!room.gameStarted) {
                    room.players.splice(playerIndex, 1);
                    io.to(roomId).emit('updatePlayers', room.players);
                } else if (room.gameStarted && !player.hasSubmitted) {
                    // המערכת תחכה לשחקן שעתיים (או עד שיגיש) כדי לא לפסול אותו סתם על ניתוק מהאינטרנט
                    setTimeout(() => {
                        if (rooms[roomId] && !player.hasSubmitted) {
                            player.hasSubmitted = true;
                            player.correctCount = 0;
                            player.time = 999; 
                            player.answers = {};
                            rooms[roomId].submittedCount++;
                            if (rooms[roomId].submittedCount === rooms[roomId].players.length) {
                                calculateAndSendResults(roomId);
                            }
                        }
                    }, 120000); // המתנה של 2 דקות
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running on port ' + PORT));
