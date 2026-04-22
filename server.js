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

// שופט ג'מיני - קפדן ופוסל במקרה של ספק או שגיאה
app.post('/api/ask-judge', async (req, res) => {
    const { category, letter, answer } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `אתה שופט אכזר, נוקשה וחסר רחמים במשחק "ארץ עיר" בעברית.
        הקטגוריה: "${category}", האות הנדרשת: "${letter}", התשובה של השחקן: "${answer}".
        עליך לשפוט לפי כללי הברזל הבאים. כל חריגה גוררת פסילה מיידית:
        1. שיוך מדויק (קריטי!): המילה חייבת להיות בדיוק מה שהקטגוריה דורשת. אם הקטגוריה היא "איבר גוף", "מצקת" זו פסילה. אם זה "עיר בירה", "אילת" זו פסילה כי היא עיר רגילה. אם זה לא מתאים ב-100% - פסול!
        2. האות הראשונה: התשובה חייבת להתחיל באות "${letter}". שגיאה באות הראשונה = פסול.
        3. אין המצאות וביטויים: פסול מילים מומצאות או משפטים כמו "מה אתה אומר".
        4. שגיאות כתיב קלות: מותר לאשר שגיאת כתיב קלה של אות אחת בלבד (רק באמצע או בסוף) או חוסר/עודף של א/י, רק אם ברור למה התכוון השחקן.

        החזר אך ורק JSON תקין (ללא טקסט נוסף) במבנה הבא:
        {"isValid": true/false, "reason": "הסבר קצר של 2-4 מילים"}`;
        
        let isResolved = false;
        const timeout = new Promise((resolve) => setTimeout(() => {
            if (!isResolved) resolve({ timeout: true });
        }, 5500));
        
        const result = model.generateContent(prompt).then(r => {
            isResolved = true; return r;
        }).catch(e => {
            isResolved = true; return { error: true };
        });
        
        const response = await Promise.race([result, timeout]);
        
        // כאן שינינו: במקרה של עומס או שגיאה - פוסלים!
        if (response.timeout) return res.json({ isValid: false, reason: "נפסל (השופט לא ענה)" });
        if (response.error) return res.json({ isValid: false, reason: "נפסל (שגיאת תקשורת)" });

        let text = response.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (e) {
        res.json({ isValid: false, reason: "נפסל (תקלת מערכת)" });
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
            rooms[roomId] = { players: [], letter: letters[Math.floor(Math.random() * letters.length)], submittedCount: 0, gameStarted: false };
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
        const myPlayer = room.players.find(p => p.name === playerName);
        socket.emit('roomJoined', { roomId, letter: room.letter, isHost: myPlayer.isHost });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (roomId) => {
        if(rooms[roomId]) {
            rooms[roomId].gameStarted = true;
            io.to(roomId).emit('gameStarted', rooms[roomId].letter);
        }
    });

    socket.on('announceFinish', ({ roomId, playerName }) => {
        io.to(roomId).emit('playerAnnouncedFinish', playerName);
    });

    socket.on('submitScore', ({ roomId, correctCount, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('gameError', 'השרת עבר ריענון והחדר אבד. נאלץ להתחיל משחק חדש.');
        
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) {
            player.correctCount = correctCount;
            player.time = timeInSeconds;
            player.answers = answers;
            player.hasSubmitted = true;
            room.submittedCount++;
            
            const waitingFor = room.players.filter(p => !p.hasSubmitted).map(p => p.name);
            io.to(roomId).emit('playerFinishedStatus', {
                playerName: player.name,
                submittedCount: room.submittedCount,
                totalPlayers: room.players.length,
                waitingFor: waitingFor
            });

            if (room.submittedCount === room.players.length) calculateAndSendResults(roomId);
        }
    });

    socket.on('forceEndGame', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const host = room.players.find(p => p.id === socket.id);
        if (host && host.isHost) {
            if (!host.hasSubmitted && data.forceHostSubmit) {
                host.correctCount = data.myCorrectCount || 0;
                host.time = data.myTime || 999;
                host.answers = data.myAnswers || {};
                host.hasSubmitted = true;
                room.submittedCount++;
            }
            room.players.forEach(p => {
                if (!p.hasSubmitted) {
                    p.hasSubmitted = true;
                    p.correctCount = 0; p.time = 999; p.answers = {};
                    room.submittedCount++;
                }
            });
            calculateAndSendResults(data.roomId);
        }
    });

    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.gameStarted = false;
            room.submittedCount = 0;
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            room.players.forEach(p => { p.hasSubmitted = false; p.correctCount = 0; p.time = 0; p.answers = {}; p.finalScore = 0; });
            io.to(roomId).emit('returnToLobby', { letter: room.letter, players: room.players });
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
                } else if (room.gameStarted && !room.players[playerIndex].hasSubmitted) {
                    setTimeout(() => {
                        if (rooms[roomId] && rooms[roomId].players[playerIndex] && !rooms[roomId].players[playerIndex].hasSubmitted) {
                            rooms[roomId].players[playerIndex].hasSubmitted = true;
                            rooms[roomId].players[playerIndex].correctCount = 0;
                            rooms[roomId].players[playerIndex].time = 999; 
                            rooms[roomId].players[playerIndex].answers = {};
                            rooms[roomId].submittedCount++;
                            if (rooms[roomId].submittedCount === rooms[roomId].players.length) calculateAndSendResults(roomId);
                        }
                    }, 60000); 
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running'));
