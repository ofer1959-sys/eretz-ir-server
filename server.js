require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const aiApprovedWords = {};
const rooms = {};

// משתנה שיחזיק את המודל שהמערכת מצאה שפתוח עבורך
let activeModelName = "gemini-1.5-flash"; 

// ==========================================
// מנגנון גילוי אוטומטי של מודלים (מונע שגיאות 404)
// ==========================================
async function discoverAvailableModel() {
    // ניקוי רווחים מיותרים מהמפתח שמוזן ב-Render (גורם נפוץ לשגיאות)
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    
    if (!apiKey) {
        console.error("❌ לא נמצא מפתח API של ג'מיני במשתני הסביבה!");
        return;
    }

    try {
        console.log("🔍 בודק אילו מודלים פתוחים עבור מפתח ה-API שלך...");
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("❌ שגיאה מהשרת של גוגל לגבי המפתח שלך:", data.error.message);
            return;
        }

        if (data.models) {
            const modelNames = data.models.map(m => m.name);
            console.log("✅ המודלים הזמינים למפתח שלך הם:");
            console.log(modelNames.join(', '));

            // בחירת המודל החכם ביותר שקיים ברשימה המורשית שלך
            if (modelNames.includes('models/gemini-1.5-flash')) {
                activeModelName = 'gemini-1.5-flash';
            } else if (modelNames.includes('models/gemini-1.5-pro')) {
                activeModelName = 'gemini-1.5-pro';
            } else if (modelNames.includes('models/gemini-1.0-pro')) {
                activeModelName = 'gemini-1.0-pro';
            } else if (modelNames.includes('models/gemini-pro')) {
                activeModelName = 'gemini-pro';
            } else if (modelNames.length > 0) {
                // לוקח את המודל הראשון ברשימה אם המוכרים לא נמצאו
                activeModelName = modelNames[0].replace('models/', '');
            }
            console.log(`🎯 המודל שנבחר אוטומטית למשחק הוא: ${activeModelName}`);
        }
    } catch (error) {
        console.error("❌ שגיאה במהלך איתור המודלים:", error.message);
    }
}

// קריאה לפונקציה מיד עם עליית השרת
discoverAvailableModel();

// ==========================================
// תקשורת ישירה מול השופט
// ==========================================
async function callGeminiAPI(prompt) {
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    if (!apiKey) {
        throw new Error("מפתח ה-API חסר בשרת.");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModelName}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    const data = await response.json();

    if (data.error) {
        throw new Error(data.error.message || "שגיאה לא ידועה מהשרת של גוגל");
    }

    if (!data.candidates || !data.candidates[0].content || !data.candidates[0].content.parts) {
        throw new Error("התקבלה תשובה ריקה מג'מיני.");
    }

    return data.candidates[0].content.parts[0].text;
}

app.post('/api/ask-judge-batch', async (req, res) => {
    try {
        const { letter, items } = req.body;
        if (!items || items.length === 0) {
            return res.json({ results: {} });
        }

        let promptList = items.map(item => `קטגוריה: ${item.categoryLabel} (ID: ${item.catId}) | מילה לבדיקה: "${item.answer}"`).join('\n');

        const prompt = `
אתה שופט במשחק 'ארץ עיר' בעברית. בדוק את המילים הבאות שמתחילות באות '${letter}'.
חוקים:
1. המילה חייבת להיות קיימת בעברית (או שם לועזי מקובל מאוד בעברית).
2. קבל שגיאות כתיב קלות אם הכוונה ברורה, אבל הורד את הניקוד ל-5.
3. התעלם מה' הידיעה בתחילת מילה.
4. אם המילה נכונה ותקינה, הניקוד הוא 10.
5. אם המילה אינה קשורה לקטגוריה, אינה קיימת, או אינה באות הנכונה, הניקוד הוא 0.

רשימת המילים לבדיקה:
${promptList}

עליך להחזיר אך ורק מבנה JSON תקין כפי שמוצג בדוגמה הבאה, ללא שום טקסט נוסף:
{
  "results": {
    "catId_1": { "points": 10, "reason": "תשובה נכונה" },
    "catId_2": { "points": 5, "reason": "שגיאת כתיב קלה" }
  }
}`;

        const responseText = await callGeminiAPI(prompt);
        
        let jsonString = responseText;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonString = jsonMatch[0];
        }
        
        const parsedData = JSON.parse(jsonString);
        res.json(parsedData);
    } catch (error) {
        console.error("\n=== שגיאת תקשורת מול ג'מיני ===");
        console.error(error);
        console.error("================================\n");
        const errorMessage = error.message || error.toString() || "שגיאה לא ידועה";
        res.status(500).json({ error: `תקלת שופט: ${errorMessage}` });
    }
});

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const randomLetter = letters[Math.floor(Math.random() * letters.length)];
        
        rooms[roomId] = {
            host: socket.id,
            hostName: data.hostName,
            letter: randomLetter,
            disabledCategories: data.disabledCategories || [],
            players: [{ socketId: socket.id, name: data.hostName, isHost: true }],
            submissions: []
        };
        
        socket.join(roomId);
        socket.emit('roomCreated', { 
            roomId, 
            letter: randomLetter, 
            disabledCategories: rooms[roomId].disabledCategories,
            players: rooms[roomId].players 
        });
    });

    socket.on('joinRoom', (data) => {
        const { roomId, playerName, isHostClaim } = data;
        const room = rooms[roomId];
        
        if (!room) {
            socket.emit('gameError', 'החדר לא קיים או שנסגר.');
            return;
        }
        
        const existingPlayer = room.players.find(p => p.socketId === socket.id || p.name === playerName);
        let isHost = false;
        
        if (existingPlayer) {
            existingPlayer.socketId = socket.id;
            isHost = existingPlayer.isHost;
        } else {
            isHost = isHostClaim && room.host === socket.id;
            room.players.push({ socketId: socket.id, name: playerName, isHost });
        }
        
        socket.join(roomId);
        socket.emit('roomJoined', { 
            roomId, 
            letter: room.letter,
            disabledCategories: room.disabledCategories,
            isHost 
        });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            room.submissions = [];
            io.to(data.roomId).emit('gameStarted', { 
                letter: room.letter,
                disabledCategories: room.disabledCategories
            });
        }
    });

    socket.on('announceFinish', (data) => {
        socket.to(data.roomId).emit('playerAnnouncedFinish', data.playerName);
    });

    socket.on('submitScore', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        const existingSub = room.submissions.find(s => s.name === player.name);
        if (!existingSub) {
            room.submissions.push({
                name: player.name,
                score: data.totalScore,
                time: data.timeInSeconds,
                answers: data.answers
            });
        }

        const waitingFor = room.players.filter(p => !room.submissions.find(s => s.name === p.name)).map(p => p.name);

        io.to(data.roomId).emit('playerFinishedStatus', {
            playerName: player.name,
            submittedCount: room.submissions.length,
            totalPlayers: room.players.length,
            waitingFor
        });

        if (room.submissions.length >= room.players.length) {
            processAndSendResults(data.roomId);
        }
    });

    socket.on('forceEndGame', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            if (data.forceHostSubmit) {
                const player = room.players.find(p => p.socketId === socket.id);
                if (player && !room.submissions.find(s => s.name === player.name)) {
                    room.submissions.push({
                        name: player.name,
                        score: data.myTotalScore,
                        time: data.myTime,
                        answers: data.myAnswers
                    });
                }
            }
            
            room.players.forEach(p => {
                if (!room.submissions.find(s => s.name === p.name)) {
                    room.submissions.push({
                        name: p.name,
                        score: 0,
                        time: 999,
                        answers: {}
                    });
                }
            });
            processAndSendResults(data.roomId);
        }
    });

    socket.on('announceAppeal', (data) => {
        io.to(data.roomId).emit('appealStarted', data.playerName);
    });

    socket.on('submitAppeal', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        
        let sub = room.submissions.find(s => s.name === data.playerName);
        if (sub) {
            sub.score = data.newTotalScore;
            sub.answers = data.answers;
        }
        processAndSendResults(data.roomId);
    });

    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room && room.host === socket.id) {
            room.submissions = [];
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            io.to(roomId).emit('returnToLobby', { 
                letter: room.letter, 
                players: room.players,
                disabledCategories: room.disabledCategories
            });
        }
    });

    socket.on('logApprovedWord', (data) => {
        if (!aiApprovedWords[data.category]) {
            aiApprovedWords[data.category] = new Set();
        }
        aiApprovedWords[data.category].add(data.word);
    });

    socket.on('getApprovedWords', () => {
        const formatted = {};
        for (let cat in aiApprovedWords) {
            formatted[cat] = Array.from(aiApprovedWords[cat]);
        }
        socket.emit('receiveApprovedWords', formatted);
    });

    socket.on('clearCategoryWords', (category) => {
        if (aiApprovedWords[category]) {
            aiApprovedWords[category].clear();
        }
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            const room = rooms[roomId];
            const pIndex = room.players.findIndex(p => p.socketId === socket.id);
            if (pIndex !== -1) {
                const isHost = room.players[pIndex].isHost;
                room.players.splice(pIndex, 1);
                io.to(roomId).emit('updatePlayers', room.players);
                
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else if (isHost) {
                    room.players[0].isHost = true;
                    room.host = room.players[0].socketId;
                    io.to(room.players[0].socketId).emit('roomJoined', { 
                        roomId, 
                        letter: room.letter, 
                        disabledCategories: room.disabledCategories,
                        isHost: true 
                    });
                    io.to(roomId).emit('updatePlayers', room.players);
                }
            }
        }
    });
});

function processAndSendResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let validSubmissions = room.submissions.filter(s => s.time !== 999);
    let bestTime = validSubmissions.length > 0 ? Math.min(...validSubmissions.map(s => s.time)) : 0;

    const leaderboard = room.submissions.map(sub => {
        let penalty = 0;
        if (sub.time !== 999 && bestTime > 0) {
            let threshold = bestTime * 1.5;
            if (sub.time > threshold) {
                let extraTime = sub.time - threshold;
                let penaltySteps = Math.ceil(extraTime / (bestTime * 0.1));
                penalty = penaltySteps * 5;
            }
        }
        let finalScore = Math.max(0, sub.score - penalty);
        return { ...sub, finalScore, penalty };
    });

    leaderboard.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        return a.time - b.time;
    });

    io.to(roomId).emit('gameOver', leaderboard);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
