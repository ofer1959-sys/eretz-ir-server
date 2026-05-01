const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = (process.env.GEMINI_API_KEY || "MISSING_KEY").trim();
const emailUser = (process.env.EMAIL_USER || "").trim();
const emailPass = (process.env.EMAIL_PASS || "").trim();

console.log("=== SERVER STARTUP ===");
console.log("API Key loaded:", apiKey === "MISSING_KEY" ? "NO" : "YES");
console.log("✅ שופט AI פעיל: gemini-3.1-flash-lite-preview");

// ==========================================
// הגדרת מערכת הדיוור - מעקף לחסימת הרשת ב-Render (פורט 587)
// ==========================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // חובה לשים false כשמשתמשים בפורט 587
    requireTLS: true,
    auth: {
        user: emailUser,
        pass: emailPass
    },
    family: 4 // הפקודה שמצילה אותנו מהחסימה ב-Render
});

if (emailUser && emailPass) {
    transporter.verify(function(error, success) {
        if (error) {
            console.error("שגיאה בחיבור למייל:", error.message);
        } else {
            console.log("📧 מערכת הדיוור האוטומטית מוכנה.");
        }
    });
} else {
    console.log("⚠️ חסרים פרטי אימייל (EMAIL_USER / EMAIL_PASS) - לא יישלחו מיילים.");
}

const rooms = {};

// ==========================================
// פנייה לג'מיני
// ==========================================
async function askGeminiDirectly(promptText) {
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=$){apiKey}`;
    
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

app.get('/api/test-gemini', async (req, res) => {
    if (apiKey === "MISSING_KEY") return res.json({ status: "Error", message: "API Key is missing." });
    try {
        const text = await askGeminiDirectly("השב במילה אחת בלבד: האם אתה מחובר?");
        res.json({ status: "Success", gemini_response: text.trim() });
    } catch (e) {
        res.json({ status: "Error", message: e.message });
    }
});

// ==========================================
// שופט ה-AI
// ==========================================
app.post('/api/ask-judge-batch', async (req, res) => {
    const { letter, items } = req.body;
    
    if (apiKey === "MISSING_KEY") {
        let results = {};
        items.forEach(i => { results[i.catId] = { points: 5, reason: "אין מפתח API בשרת" }; });
        return res.json({ results });
    }

    try {
        const prompt = `אתה שופט ערעורים במשחק "ארץ עיר" בעברית. האות הנדרשת: "${letter}".
        בדוק את רשימת התשובות הבאות.
        
        כללי הערעור:
        1. האות הראשונה: המילה חייבת להתחיל באות "${letter}". אם לא - פסול (0 נקודות).
        2. רווחים וכתיב: התעלם מרווחים (למשל "פופ קורן" = "פופקורן"), והתעלם מ-א/י/ו/ה עודפות או חסרות.
        3. שמות ויישובים: אשר יישובים קטנים בישראל, מקצועות ומילים לגיטימיות גם אם הן נדירות או צורת זכר/נקבה.
        4. הערכת ניקוד: 
           - 10 נקודות לתשובה מדויקת ותקנית.
           - 5 נקודות לתשובה קרובה, סלנג, או טעות כתיב צורמת של אות אחת.
           - 0 נקודות לתשובה שגויה לחלוטין.

        הוראה קריטית לגבי הסברים (reason):
        אם אתה מעניק 0 או 5 נקודות, עליך לכתוב הסבר קצר לסיבה. ההסבר חייב להיות באורך של עד 12 מילים לכל היותר!
        אם אישרת במלואו (10 נקודות), כתוב פשוט "אושר".

        התשובות לבדיקה:
        ${items.map(i => `- מזהה: "${i.catId}", קטגוריה: "${i.categoryLabel}", תשובה של השחקן: "${i.answer}"`).join('\n')}

        החזר אך ורק JSON תקין (ללא טקסט נוסף וללא עיצוב) במבנה הבא:
        {
          "results": {
            "catId_1": {"points": 10, "reason": "אושר"},
            "catId_2": {"points": 0, "reason": "הסבר עד 12 מילים"}
          }
        }`;
        
        let isResolved = false;
        const timeout = new Promise((resolve) => setTimeout(() => {
            if (!isResolved) resolve({ timeout: true });
        }, 25000));
        
        const result = askGeminiDirectly(prompt).then(text => {
            isResolved = true; 
            return { text: text };
        }).catch(e => {
            isResolved = true; 
            return { error: true, details: e.message }; 
        });
        
        const response = await Promise.race([result, timeout]);
        
        if (response.timeout || response.error) {
            let results = {};
            items.forEach(i => { results[i.catId] = { points: 5, reason: "עומס ברשת - אושר חלקית" }; });
            return res.json({ results });
        }

        // התיקון הקריטי: חסין לתקלות העתק-הדבק של GitHub
        let cleanText = response.text.split('```json').join('').split('```').join('').trim();
        res.json(JSON.parse(cleanText));
        
    } catch (e) {
        let results = {};
        items.forEach(i => { results[i.catId] = { points: 5, reason: "תקלת שרת - אושר חלקית" }; });
        res.json({ results });
    }
});

// ==========================================
// ניהול ניקוד ושליחת מייל
// ==========================================
function calculateAndSendResults(roomId, isAppeal = false) {
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

    if (emailUser && emailPass && (!room.emailSent || isAppeal)) {
        room.emailSent = true; 
        
        let subjectText = isAppeal ? `עדכון תוצאות לאחר ערעור - אות ${room.letter}` : `תוצאות ארץ עיר - אות ${room.letter}`;
        let emailHtml = `<h2 style="color:#4a90e2; text-align:center;">${subjectText}</h2>
                         <table border="1" cellpadding="10" cellspacing="0" style="margin: 0 auto; width: 100%; max-width: 600px; text-align: center; border-collapse: collapse;">
                            <tr style="background-color: #f5a623; color: white;">
                                <th>מקום</th><th>שחקן</th><th>ניקוד</th><th>זמן (שניות)</th>
                            </tr>`;
        
        room.players.forEach((p, idx) => {
            emailHtml += `<tr>
                            <td>${idx+1}</td>
                            <td style="font-weight:bold;">${p.name}</td>
                            <td style="color:green; font-weight:bold;">${p.finalScore}</td>
                            <td>${p.time === 999 ? 'פרש' : p.time}</td>
                          </tr>`;
        });
        
        emailHtml += `</table><br><p style="text-align:center;">נשלח אוטומטית מהשרת של סבא עופר 👑</p>`;

        const mailOptions = {
            from: emailUser,
            to: emailUser,
            subject: subjectText,
            html: `<div dir="rtl">${emailHtml}</div>`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("שגיאה בשליחת המייל:", error.message);
            } else {
                console.log("📧 מייל סיכום משחק נשלח בהצלחה!");
            }
        });
    }
}

// ==========================================
// ניהול החדרים (Socket.io)
// ==========================================
io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const gameLetter = letters[Math.floor(Math.random() * letters.length)];
        
        rooms[roomId] = { 
            players: [], 
            letter: gameLetter, 
            submittedCount: 0, 
            gameStarted: false,
            emailSent: false,
            disabledCategories: data.disabledCategories || []
        };
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, name: data.hostName, isHost: true, hasSubmitted: false });
        socket.emit('roomCreated', { roomId, letter: gameLetter, players: rooms[roomId].players, disabledCategories: rooms[roomId].disabledCategories });
    });

    socket.on('joinRoom', ({ roomId, playerName, isHostClaim }) => {
        let room = rooms[roomId];
        if (!room) {
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            rooms[roomId] = { players: [], letter: letters[Math.floor(Math.random() * letters.length)], submittedCount: 0, gameStarted: false, emailSent: false, disabledCategories: [] };
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
        socket.emit('roomJoined', { roomId, letter: room.letter, isHost: myPlayer.isHost, disabledCategories: room.disabledCategories });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (data) => {
        const roomId = data.roomId;
        if(rooms[roomId]) {
            rooms[roomId].gameStarted = true;
            io.to(roomId).emit('gameStarted', { 
                letter: rooms[roomId].letter, 
                disabledCategories: rooms[roomId].disabledCategories 
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

            if (room.submittedCount === room.players.length) calculateAndSendResults(roomId, false);
        }
    });

    socket.on('submitAppeal', ({ roomId, playerName, newTotalScore, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.name === playerName);
        if (player) {
            player.baseScore = newTotalScore;
            player.answers = answers;
            calculateAndSendResults(roomId, true);
        }
    });

    socket.on('announceAppeal', ({ roomId, playerName }) => {
        io.to(roomId).emit('appealStarted', playerName);
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
            calculateAndSendResults(data.roomId, false);
        }
    });

    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.gameStarted = false;
            room.submittedCount = 0;
            room.emailSent = false;
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            room.players.forEach(p => { p.hasSubmitted = false; p.baseScore = 0; p.time = 0; p.answers = {}; p.finalScore = 0; });
            io.to(roomId).emit('returnToLobby', { letter: room.letter, players: room.players, disabledCategories: room.disabledCategories });
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
                            if (rooms[roomId].submittedCount === rooms[roomId].players.length) calculateAndSendResults(roomId, false);
                        }
                    }, 60000); 
                }
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server is running on port ' + PORT));
