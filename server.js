require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const rooms = {};

// הגדרת סוכן המיילים
let transporter;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    });
}

// פונקציה לשליחת דוח מפורט הכולל את כל התשובות והנימוקים
async function sendDetailedReport(historyRecord, allAnswers) {
    if (!transporter) return;
    try {
        let html = `
        <div style="font-family: 'Segoe UI', Tahoma, sans-serif; direction: rtl; text-align: right; background-color: #f4f7f6; padding: 20px;">
            <h2 style="color: #2c3e50; border-bottom: 2px solid #4a90e2; padding-bottom: 10px;">📊 דוח משחק מפורט - סבא עופר</h2>
            <p><strong>תאריך:</strong> ${historyRecord.date} | <strong>שעה:</strong> ${historyRecord.time}</p>
            <p><strong>האות שנבחרה:</strong> <span style="font-size: 1.8em; color: #e67e22; font-weight: bold;">${historyRecord.letter}</span></p>
            
            <h3 style="color: #2980b9;">📋 פירוט תשובות וניקוד:</h3>
        `;

        // יצירת טבלה לכל שחקן
        for (let playerName in allAnswers) {
            html += `
            <div style="background: white; margin-bottom: 20px; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                <h4 style="margin-top: 0; color: #4a90e2; border-right: 4px solid #4a90e2; padding-right: 10px;">שחקן: ${playerName}</h4>
                <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                    <thead>
                        <tr style="background-color: #ecf0f1;">
                            <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">קטגוריה</th>
                            <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">תשובה</th>
                            <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">ניקוד</th>
                            <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">סטטוס / נימוק השופט</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            const answers = allAnswers[playerName];
            for (let catLabel in answers) {
                const ans = answers[catLabel];
                const rowColor = ans.points === 0 ? "#fff5f5" : (ans.points < 10 ? "#fffaf0" : "#fafffa");
                const statusIcon = ans.points === 0 ? "❌" : "✅";
                
                html += `
                <tr style="background-color: ${rowColor};">
                    <td style="padding: 8px; border: 1px solid #ddd;">${catLabel}</td>
                    <td style="padding: 8px; border: 1px solid #ddd;"><strong>${ans.val || "---"}</strong></td>
                    <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${ans.points}</td>
                    <td style="padding: 8px; border: 1px solid #ddd; font-size: 0.9em;">${statusIcon} ${ans.feedback || ""}</td>
                </tr>
                `;
            }
            html += `</tbody></table></div>`;
        }

        html += `</div>`;

        await transporter.sendMail({
            from: `"ארץ עיר - בקרה" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `🎮 דוח בקרה: משחק באות ${historyRecord.letter} הסתיים`,
            html: html
        });
        console.log(`📧 מייל בקרה מפורט נשלח בהצלחה.`);
    } catch (e) {
        console.error("❌ שגיאה בשליחת המייל:", e.message);
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
        const validModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'));
        const sortedModels = validModels.sort((a, b) => a.name.includes('flash') ? -1 : 1);
        for (let m of sortedModels) {
            const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${m.name}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({contents: [{parts: [{text: "test"}]}]})
            });
            const testData = await testRes.json();
            if (!testData.error) {
                activeModelName = m.name.replace('models/', '');
                console.log(`✅ שופט AI מוכן לשימוש (${activeModelName})`);
                return;
            }
        }
    } catch (e) {}
}
initializeGemini();

async function callGeminiAPI(prompt) {
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModelName}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

app.post('/api/ask-judge-batch', async (req, res) => {
    try {
        const { letter, items } = req.body;
        let promptList = items.map(item => `קטגוריה: ${item.categoryLabel} (ID: ${item.catId}) | מילה: "${item.answer}"`).join('\n');
        const prompt = `אתה שופט במשחק 'ארץ עיר' באות '${letter}'.
עליך לבדוק את המילים ברשימה ולהחזיר JSON עם ה-ID המדויק לכל קטגוריה.
חוקים:
1. מילה תקינה = 10 נקודות.
2. שגיאת כתיב קלה / מילה גבולית אך נכונה = 5 נקודות.
3. לא קשור לקטגוריה / לא באות הנכונה / לא קיים = 0 נקודות.
4. חובה לתת נימוק קצר וברור בשדה 'reason' (למשל: "יישוב קיים בישראל", "שגיאת כתיב קלה", "לא מתחיל באות הנכונה").

רשימה:
${promptList}

החזר רק JSON בפורמט:
{"results": {"catId": {"points": 10, "reason": "נימוק" }}}`;

        const responseText = await callGeminiAPI(prompt);
        let jsonString = responseText.match(/\{[\s\S]*\}/)[0];
        res.json(JSON.parse(jsonString));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        rooms[roomId] = {
            host: socket.id, hostName: data.hostName, letter: letters[Math.floor(Math.random() * letters.length)],
            disabledCategories: data.disabledCategories || [], players: [{ socketId: socket.id, name: data.hostName, isHost: true }], submissions: []
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, letter: rooms[roomId].letter, disabledCategories: rooms[roomId].disabledCategories, players: rooms[roomId].players });
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (!room) return socket.emit('gameError', 'החדר נסגר.');
        room.players.push({ socketId: socket.id, name: data.playerName, isHost: false });
        socket.join(data.roomId);
        socket.emit('roomJoined', { roomId: data.roomId, letter: room.letter, disabledCategories: room.disabledCategories, isHost: false });
        io.to(data.roomId).emit('updatePlayers', room.players);
    });

    socket.on('startGame', (data) => {
        const room = rooms[data.roomId];
        if (room) { room.submissions = []; io.to(data.roomId).emit('gameStarted', { letter: room.letter, disabledCategories: room.disabledCategories }); }
    });

    socket.on('submitScore', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        room.submissions.push({ name: data.playerName, score: data.totalScore, time: data.timeInSeconds, answers: data.answers });
        if (room.submissions.length >= room.players.length) processAndSendResults(data.roomId);
    });

    socket.on('logSinglePlayerHistory', (data) => {
        if (data.historyRecord) {
            const allAnswers = {};
            allAnswers[data.historyRecord.players[0].name] = data.fullAnswers;
            sendDetailedReport(data.historyRecord, allAnswers);
        }
    });

    socket.on('disconnect', () => { /* ניקוי חדרים */ });
});

function processAndSendResults(roomId) {
    const room = rooms[roomId];
    const leaderboard = [...room.submissions].sort((a,b) => b.score - a.score);
    const dateObj = new Date();
    const historyRecord = {
        date: dateObj.toLocaleDateString('he-IL'),
        time: dateObj.toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}),
        letter: room.letter,
        players: leaderboard.map(p => ({ name: p.name, score: p.score }))
    };

    const allAnswers = {};
    room.submissions.forEach(s => allAnswers[s.name] = s.answers);
    
    sendDetailedReport(historyRecord, allAnswers);
    io.to(roomId).emit('gameOver', { leaderboard, historyRecord });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
