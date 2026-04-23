const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = (process.env.GEMINI_API_KEY || "MISSING_KEY").trim();

const rooms = {};

async function askGeminiDirectly(promptText) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }]
        })
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`HTTP Error ${response.status}`);
    }

    const data = await response.json();
    if (data && data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text;
    } else {
        throw new Error("No valid response");
    }
}

app.post('/api/ask-judge-batch', async (req, res) => {
    const { letter, items } = req.body;
    
    if (apiKey === "MISSING_KEY") {
        let results = {};
        items.forEach(i => { results[i.catId] = { points: 5, reason: "חסר מפתח API" }; });
        return res.json({ results });
    }

    try {
        const prompt = `אתה שופט "ארץ עיר". האות: "${letter}". בדוק את התשובות הבאות:
        ${items.map(i => `- מזהה: "${i.catId}", קטגוריה: "${i.categoryLabel}", תשובה: "${i.answer}"`).join('\n')}

        כללים:
        1. חייב להתחיל ב-"${letter}".
        2. התעלם מרווחים ו-א/י/ו/ה. 
        3. 10 נק' לתקין, 5 נק' לכמעט/סלנג, 0 לשגוי.
        4. הסבר (reason) עד 12 מילים בלבד! אם 10 נק', כתוב "אושר".

        החזר אך ורק JSON במבנה:
        {"results": {"מזהה": {"points": 10/5/0, "reason": "הסבר"}}} `;
        
        let isResolved = false;
        // הגדלנו את זמן ההמתנה ל-25 שניות כדי למנוע הודעות "עומס ברשת"
        const timeout = new Promise((resolve) => setTimeout(() => {
            if (!isResolved) resolve({ timeout: true });
        }, 25000));
        
        const result = askGeminiDirectly(prompt).then(text => {
            isResolved = true; 
            return { text: text };
        }).catch(e => {
            isResolved = true; 
            return { error: true }; 
        });
        
        const response = await Promise.race([result, timeout]);
        
        if (response.timeout || response.error) {
            let results = {};
            items.forEach(i => { results[i.catId] = { points: 5, reason: "עומס זמני - אושר חלקית" }; });
            return res.json({ results });
        }

        let cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(cleanText));
    } catch (e) {
        let results = {};
        items.forEach(i => { results[i.catId] = { points: 5, reason: "שגיאת עיבוד - אושר חלקית" }; });
        res.json({ results });
    }
});

function calculateAndSendResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const minTime = Math.min(...room.players.filter(p => p.time < 999).map(p => p.time));
    room.players.forEach(p => {
        let score = p.baseScore || 0; 
        if (minTime > 0 && minTime !== Infinity && p.time < 999) {
            const excessRatio = (p.time - minTime) / minTime;
            if (excessRatio > 0.50) {
                const penalties = Math.floor(excessRatio / 0.10);
                score -= (penalties * 5);
            }
        }
        p.finalScore = Number(Math.max(0, score).toFixed(2));
    });
    room.players.sort((a, b) => (b.finalScore - a.finalScore) || (a.time - b.time));
    io.to(roomId).emit('gameOver', room.players);
}

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const gameLetter = letters[Math.floor(Math.random() * letters.length)];
        rooms[roomId] = { players: [], letter: gameLetter, submittedCount: 0, gameStarted: false, disabledCategories: data.disabledCategories || [] };
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, name: data.hostName, isHost: true, hasSubmitted: false });
        socket.emit('roomCreated', { roomId, letter: gameLetter, players: rooms[roomId].players, disabledCategories: rooms[roomId].disabledCategories });
    });

    socket.on('joinRoom', ({ roomId, playerName, isHostClaim }) => {
        let room = rooms[roomId];
        if (!room) return;
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (existingPlayer) { existingPlayer.id = socket.id; if (isHostClaim) existingPlayer.isHost = true; }
        else { room.players.push({ id: socket.id, name: playerName, isHost: false, hasSubmitted: false }); }
        socket.join(roomId);
        const myPlayer = room.players.find(p => p.name === playerName);
        socket.emit('roomJoined', { roomId, letter: room.letter, isHost: myPlayer.isHost, disabledCategories: room.disabledCategories });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomId];
        if(room) { room.gameStarted = true; io.to(data.roomId).emit('gameStarted', { letter: room.letter, disabledCategories: room.disabledCategories }); }
    });

    socket.on('submitScore', ({ roomId, totalScore, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) {
            player.baseScore = totalScore; player.time = timeInSeconds; player.answers = answers; player.hasSubmitted = true;
            room.submittedCount++;
            if (room.submittedCount === room.players.length) calculateAndSendResults(roomId);
        }
    });

    socket.on('submitAppeal', ({ roomId, playerName, newTotalScore, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.name === playerName);
        if (player) { player.baseScore = newTotalScore; player.answers = answers; calculateAndSendResults(roomId); }
    });

    socket.on('announceAppeal', ({ roomId, playerName }) => { io.to(roomId).emit('appealStarted', playerName); });

    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.gameStarted = false; room.submittedCount = 0;
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            room.players.forEach(p => { p.hasSubmitted = false; p.baseScore = 0; p.time = 0; p.answers = {}; p.finalScore = 0; });
            io.to(roomId).emit('returnToLobby', { letter: room.letter, players: room.players, disabledCategories: room.disabledCategories });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server Live'));
