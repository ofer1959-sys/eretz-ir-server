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

// קריאת המפתח מתוך Render וניקוי רווחים
const apiKey = (process.env.GEMINI_API_KEY || "MISSING_KEY").trim();

console.log("=== SERVER STARTUP ===");
console.log("API Key loaded:", apiKey === "MISSING_KEY" ? "NO" : "YES (Starts with " + apiKey.substring(0, 4) + "...)");

const rooms = {};

// ==========================================
// "נשק יום הדין": פונקציה שמדברת ישירות עם שרתי גוגל ללא תוכנת ביניים!
// ==========================================
async function askGeminiDirectly(promptText) {
    // פנייה ישירה למודל הפלאש 1.5 העדכני ביותר בגרסת הבטא
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }]
        })
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`HTTP Error ${response.status}: ${errorData}`);
    }

    const data = await response.json();
    if (data && data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text;
    } else {
        throw new Error("No valid response from Gemini");
    }
}

// ==========================================
// כלי עזר לסבא עופר לבדיקת השרת
// ==========================================
app.get('/api/test-gemini', async (req, res) => {
    if (apiKey === "MISSING_KEY") {
        return res.json({ status: "Error", message: "API Key is missing in Render environment variables." });
    }
    
    try {
        const text = await askGeminiDirectly("השב במילה אחת בלבד: האם אתה מחובר?");
        res.json({ status: "Success", api_key_start: apiKey.substring(0, 4), gemini_response: text.trim() });
    } catch (e) {
        res.json({ status: "Error", api_key_start: apiKey.substring(0, 4), message: e.message });
    }
});
// ==========================================

app.post('/api/ask-judge', async (req, res) => {
    const { category, letter, answer } = req.body;
    
    if (apiKey === "MISSING_KEY") {
        return res.json({ points: 5, reason: "אין מפתח API בשרת" });
    }

    try {
        const prompt = `אתה שופט ערעורים במשחק "ארץ עיר" בעברית. השחקן ערער על המילה שלו.
        הקטגוריה: "${category}", האות הנדרשת: "${letter}", התשובה שהשחקן כתב: "${answer}".
        
        כללי הערעור:
        1. האות הראשונה: המילה חייבת להתחיל באות "${letter}". אם לא - פסול (0 נקודות).
        2. רווחים וכתיב: התעלם מרווחים (למשל "פופ קורן" = "פופקורן"), והתעלם מ-א/י/ו/ה עודפות או חסרות, או משגיאת כתיב קלה של אות אחת.
        3. שמות ויישובים: אשר יישובים קטנים בישראל, מקצועות ומילים לגיטימיות גם אם הן נדירות.
        4. הערכת ניקוד: 
           - אם המילה נכונה ותקנית לקטגוריה - החזר points: 10.
           - אם המילה קרובה מאוד אבל עם טעות כתיב צורמת - החזר points: 5.
           - אם המילה שגויה לחלוטין לקטגוריה - החזר points: 0.

        החזר אך ורק JSON תקין (ללא טקסט נוסף וללא עיצוב) במבנה הבא:
        {"points": 10/5/0, "reason": "הסבר קצר"}`;
        
        let isResolved = false;
        const timeout = new Promise((resolve) => setTimeout(() => {
            if (!isResolved) resolve({ timeout: true });
        }, 8500));
        
        const result = askGeminiDirectly(prompt).then(text => {
            isResolved = true; 
            return { text: text };
        }).catch(e => {
            isResolved = true; 
            console.error("Gemini Direct API Error:", e.message); 
            return { error: true, details: e.message }; 
        });
        
        const response = await Promise.race([result, timeout]);
        
        if (response.timeout) return res.json({ points: 5, reason: "עומס ברשת (אושר חלקית)" });
        if (response.error) {
            return res.json({ points: 5, reason: `שגיאת רשת (אושר חלקית)` });
        }

        let cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(cleanText));
    } catch (e) {
        res.json({ points: 5, reason: "תקלת שרת (אושר חלקית)" });
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

    socket.on('startGame', (data) => {
        const roomId = data.roomId;
        const disabledCategories = data.disabledCategories || [];
        
        if(rooms[roomId]) {
            rooms[roomId].gameStarted = true;
            io.to(roomId).emit('gameStarted', { 
                letter: rooms[roomId].letter, 
                disabledCategories: disabledCategories 
            });
        }
    });

    socket.on('announceFinish', ({ roomId, playerName }) => {
        io.to(roomId).emit('playerAnnouncedFinish', playerName);
    });

    socket.on('submitScore', ({ roomId, totalScore, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('gameError', 'השרת איבד את החדר. נאלץ להתחיל משחק חדש.');
        
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) {
            player.baseScore = totalScore;
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

    socket.on('submitAppeal', ({ roomId, playerName, newTotalScore, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.name === playerName);
        if (player) {
            player.baseScore = newTotalScore;
            player.answers = answers;
            calculateAndSendResults(roomId);
        }
    });

    socket.on('announceAppeal', ({ roomId }) => {
        io.to(roomId).emit('appealStarted');
    });

    socket.on('forceEndGame', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const host = room.players.find(p => p.id === socket.id);
        if (host && host.isHost) {
            if (!host.hasSubmitted && data.forceHostSubmit) {
                host.baseScore = data.myTotalScore || 0;
                host.time = data.myTime || 999;
                host.answers = data.myAnswers || {};
                host.hasSubmitted = true;
                room.submittedCount++;
            }
            room.players.forEach(p => {
                if (!p.hasSubmitted) {
                    p.hasSubmitted = true;
                    p.baseScore = 0; p.time = 999; p.answers = {};
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
            room.players.forEach(p => { p.hasSubmitted = false; p.baseScore = 0; p.time = 0; p.answers = {}; p.finalScore = 0; });
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
                            rooms[roomId].players[playerIndex].baseScore = 0;
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
