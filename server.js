require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer'); // ספריית המיילים החדשה

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const aiApprovedWords = {};
const rooms = {};

// הגדרת סוכן המיילים (Transporter)
let transporter;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    });
    console.log("📧 מערכת הדיוור האוטומטית הוגדרה בהצלחה!");
}

// פונקציה לשליחת דוח המשחק למייל של סבא עופר
async function sendReportEmail(historyRecord, newWords) {
    if (!transporter) return;
    try {
        let html = `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background-color: #f9f9f9; padding: 20px; border-radius: 10px;">
            <h2 style="color: #4a90e2;">🏆 תוצאות משחק ארץ עיר</h2>
            <p><strong>תאריך ושעה:</strong> ${historyRecord.date} | ${historyRecord.time}</p>
            <p><strong>אות המשחק:</strong> <span style="font-size: 1.5em; color: #f5a623;">${historyRecord.letter}</span></p>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 15px; border: 1px solid #ddd; background: white;">
                <tr style="background-color: #4a90e2; color: white;">
                    <th style="padding: 10px; border: 1px solid #ddd;">מקום</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">שחקן</th>
                    <th style="padding: 10px; border: 1px solid #ddd;">ציון</th>
                </tr>
        `;
        
        historyRecord.players.forEach((p, idx) => {
            let medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '🔹';
            html += `<tr>
                <td style="padding: 10px; text-align: center; border: 1px solid #ddd;">${medal} ${idx + 1}</td>
                <td style="padding: 10px; text-align: center; border: 1px solid #ddd;"><strong>${p.name}</strong></td>
                <td style="padding: 10px; text-align: center; border: 1px solid #ddd;">${p.score} נק'</td>
            </tr>`;
        });
        html += `</table>`;

        if (newWords && newWords.length > 0) {
            html += `<h3 style="color: #27ae60; margin-top: 20px;">🧠 מילים חדשות שאושרו ע"י שופט ה-AI במשחק זה:</h3><ul style="background: white; padding: 15px 30px; border-radius: 5px; border: 1px solid #ddd;">`;
            newWords.forEach(w => {
                html += `<li style="margin-bottom: 5px;">${w}</li>`;
            });
            html += `</ul>`;
        }

        html += `</div>`;

        await transporter.sendMail({
            from: `"ארץ עיר סבא עופר" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER, // נשלח אליך!
            subject: `🎮 סיכום משחק ארץ עיר הסתיים! (אות: ${historyRecord.letter})`,
            html: html
        });
        console.log(`📧 דוח נשלח למייל עבור משחק באות ${historyRecord.letter} בהצלחה!`);
    } catch (e) {
        console.error("❌ שגיאה בשליחת אימייל:", e.message);
    }
}

// --- מנגנון איתור השופט ---
let activeModelName = null;

async function initializeGemini() {
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    if (!apiKey) return;
    try {
        const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const res = await fetch(modelsUrl);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        
        const validModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
        const sortedModels = validModels.sort((a, b) => {
            if (a.name.includes('flash')) return -1;
            if (b.name.includes('flash')) return 1;
            return 0;
        });

        for (let m of sortedModels) {
            const testUrl = `https://generativelanguage.googleapis.com/v1beta/${m.name}:generateContent?key=${apiKey}`;
            const testRes = await fetch(testUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({contents: [{parts: [{text: "test"}]}]})
            });
            const testData = await testRes.json();
            if (!testData.error) {
                activeModelName = m.name.replace('models/', '');
                console.log(`✅ מודל השופט פעיל: ${activeModelName}`);
                return;
            }
        }
    } catch (error) { console.error("שגיאה באתחול מול גוגל:", error.message); }
}

initializeGemini();

async function callGeminiAPI(prompt) {
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    if (!apiKey) throw new Error("מפתח API חסר");
    if (!activeModelName) throw new Error("מכסת חינם הסתיימה. בדוק מפתח API.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModelName}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    if (!data.candidates || !data.candidates[0].content) throw new Error("תשובה ריקה מג'מיני");
    return data.candidates[0].content.parts[0].text;
}

app.post('/api/ask-judge-batch', async (req, res) => {
    try {
        const { letter, items } = req.body;
        if (!items || items.length === 0) return res.json({ results: {} });

        let promptList = items.map(item => `קטגוריה: ${item.categoryLabel} (ID: ${item.catId}) | מילה לבדיקה: "${item.answer}"`).join('\n');
        
        const prompt = `אתה שופט במשחק 'ארץ עיר'. עליך לבדוק את המילים הבאות שמתחילות באות '${letter}'.
חוקים:
1. המילה חייבת להיות קיימת בעברית (או שם זר המקובל בעברית).
2. קבל שגיאות כתיב קלות והורד ניקוד ל-5.
3. התעלם מה' הידיעה.
4. אם המילה נכונה ותקינה, הניקוד 10.
5. אם המילה לא נכונה או לא קיימת, 0.

רשימה לבדיקה:
${promptList}

עליך להחזיר אך ורק קוד JSON.
חובה להשתמש ב-ID המדויק שקיבלת ברשימה בתור המפתח (Key) עבור כל מילה. דוגמה:
{"results":{"catId_1":{"points":10,"reason":"מקצוע קיים"}}}`;

        const responseText = await callGeminiAPI(prompt);
        let jsonString = responseText;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonString = jsonMatch[0];
        
        res.json(JSON.parse(jsonString));
    } catch (error) {
        res.status(500).json({ error: error.message });
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
            submissions: [],
            newWords: [] // מעקב אחרי מילים חדשות בחדר זה
        };
        
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, letter: randomLetter, disabledCategories: rooms[roomId].disabledCategories, players: rooms[roomId].players });
    });

    socket.on('joinRoom', (data) => {
        const { roomId, playerName, isHostClaim } = data;
        const room = rooms[roomId];
        if (!room) return socket.emit('gameError', 'החדר לא קיים או שנסגר.');
        
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
        socket.emit('roomJoined', { roomId, letter: room.letter, disabledCategories: room.disabledCategories, isHost });
        io.to(roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            room.submissions = [];
            room.newWords = []; // איפוס מילים חדשות לתחילת משחק
            io.to(data.roomId).emit('gameStarted', { letter: room.letter, disabledCategories: room.disabledCategories });
        }
    });

    socket.on('announceFinish', (data) => socket.to(data.roomId).emit('playerAnnouncedFinish', data.playerName));

    socket.on('submitScore', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        if (!room.submissions.find(s => s.name === player.name)) {
            room.submissions.push({ name: player.name, score: data.totalScore, time: data.timeInSeconds, answers: data.answers });
        }

        const waitingFor = room.players.filter(p => !room.submissions.find(s => s.name === p.name)).map(p => p.name);
        io.to(data.roomId).emit('playerFinishedStatus', { playerName: player.name, submittedCount: room.submissions.length, totalPlayers: room.players.length, waitingFor });

        if (room.submissions.length >= room.players.length) processAndSendResults(data.roomId);
    });

    socket.on('forceEndGame', (data) => {
        const room = rooms[data.roomId];
        if (room && room.host === socket.id) {
            if (data.forceHostSubmit) {
                const player = room.players.find(p => p.socketId === socket.id);
                if (player && !room.submissions.find(s => s.name === player.name)) {
                    room.submissions.push({ name: player.name, score: data.myTotalScore, time: data.myTime, answers: data.myAnswers });
                }
            }
            room.players.forEach(p => {
                if (!room.submissions.find(s => s.name === p.name)) room.submissions.push({ name: p.name, score: 0, time: 999, answers: {} });
            });
            processAndSendResults(data.roomId);
        }
    });

    socket.on('announceAppeal', (data) => io.to(data.roomId).emit('appealStarted', data.playerName));

    socket.on('backToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room && room.host === socket.id) {
            room.submissions = [];
            room.newWords = [];
            const letters = "אבגדהזחטיכלמנסעפצקרשת";
            room.letter = letters[Math.floor(Math.random() * letters.length)];
            io.to(roomId).emit('returnToLobby', { letter: room.letter, players: room.players, disabledCategories: room.disabledCategories });
        }
    });

    // כעת מקבל דיווח מלא ממשחק יחיד ומפעיל אימייל
    socket.on('logSinglePlayerHistory', (data) => {
        if (data.historyRecord) {
            sendReportEmail(data.historyRecord, data.newAiWords || []);
        }
    });

    socket.on('logApprovedWord', (data) => {
        if (!aiApprovedWords[data.category]) aiApprovedWords[data.category] = new Set();
        aiApprovedWords[data.category].add(data.word);
        
        // רישום המילה עבור המשחק הקבוצתי הספציפי כדי שתופיע במייל
        if (data.roomId && rooms[data.roomId]) {
            if (!rooms[data.roomId].newWords) rooms[data.roomId].newWords = [];
            rooms[data.roomId].newWords.push(`${data.categoryLabel}: ${data.word}`);
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
                if (room.players.length === 0) delete rooms[roomId];
                else if (isHost) {
                    room.players[0].isHost = true;
                    room.host = room.players[0].socketId;
                    io.to(room.players[0].socketId).emit('roomJoined', { roomId, letter: room.letter, disabledCategories: room.disabledCategories, isHost: true });
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
                penalty = Math.ceil((sub.time - threshold) / (bestTime * 0.1)) * 5;
            }
        }
        return { ...sub, finalScore: Math.max(0, sub.score - penalty), penalty };
    });

    leaderboard.sort((a, b) => b.finalScore !== a.finalScore ? b.finalScore - a.finalScore : a.time - b.time);

    const dateObj = new Date();
    const historyRecord = {
        date: dateObj.toLocaleDateString('he-IL'),
        time: dateObj.toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
        letter: room.letter,
        players: leaderboard.map(p => ({ name: p.name, score: p.finalScore }))
    };

    // שליחת אימייל אוטומטי למנהל
    sendReportEmail(historyRecord, room.newWords || []);

    io.to(roomId).emit('gameOver', { leaderboard, historyRecord });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
