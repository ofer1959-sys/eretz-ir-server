{const express = require('express');
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

// שופט ג'מיני מקל
app.post('/api/ask-judge', async (req, res) => {
    const { category, letter, answer } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `אתה שופט במשחק "ארץ עיר". שחקן התבקש להביא מילה בקטגוריה "${category}" שמתחילה באות "${letter}".
        השחקן כתב: "${answer}".
        הגישה הכללית שלך חייבת להיות מקלה! כלומר, אם זה לא ממש לא מוחלט, תאשר את התשובה. 
        קבל שגיאות כתיב, כתיב חסר/מלא, סלנג נפוץ או הטיות.
        החזר אך ורק JSON תקין במבנה הבא: {"isValid": true/false, "reason": "הסבר קצר"}`;
        
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (e) {
        res.json({ isValid: true, reason: "אישרנו מחמת הספק, השופט כרגע עסוק" });
    }
});

// ניהול תחרות מרובת משתתפים
io.on('connection', (socket) => {
    socket.on('createRoom', (hostName) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const gameLetter = letters[Math.floor(Math.random() * letters.length)];
        
        rooms[roomId] = { players: [], hostId: socket.id, letter: gameLetter, submittedCount: 0 };
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, name: hostName, isHost: true });
        
        socket.emit('roomCreated', { roomId, letter: gameLetter, players: rooms[roomId].players });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (room) {
            socket.join(roomId);
            room.players.push({ id: socket.id, name: playerName, isHost: false });
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('startGame', (roomId) => {
        io.to(roomId).emit('gameStarted', rooms[roomId].letter);
    });

    socket.on('submitScore', ({ roomId, correctCount, timeInSeconds }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.correctCount = correctCount;
            player.time = timeInSeconds;
            room.submittedCount++;
        }

        // כשכולם מסיימים - חישוב תוצאות
        if (room.submittedCount === room.players.length) {
            const minTime = Math.min(...room.players.map(p => p.time));
            
            room.players.forEach(p => {
                let score = p.correctCount * 10;
                const excessRatio = (p.time - minTime) / minTime;
                
                // קנס על איטיות יתר (יותר מ-50%)
                if (excessRatio > 0.50) {
                    const penalties = Math.floor(excessRatio / 0.10); // על כל 10%
                    score -= (penalties * 5);
                }
                p.finalScore = Math.max(0, score);
            });

            // מיון מנצחים
            room.players.sort((a, b) => {
                if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
                return a.time - b.time;
            });

            io.to(roomId).emit('gameOver', room.players);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running'));