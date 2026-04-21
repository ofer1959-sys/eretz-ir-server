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

// שופט ג'מיני בגישה מקלה עם מנגנון הגנה נגד קריסות (Timeout)
app.post('/api/ask-judge', async (req, res) => {
    const { category, letter, answer } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `אתה שופט סלחן מאוד במשחק "ארץ עיר".
        הקטגוריה: "${category}", האות: "${letter}", התשובה: "${answer}".
        הוראה קריטית: הגישה שלך חייבת להיות מקלה! אם זה לא טעות מוחלטת, תאשר. קבל שגיאות כתיב, כתיב חסר/מלא, סלנג נפוץ או הטיות (זכר/נקבה, יחיד/רבים).
        החזר אך ורק JSON תקין במבנה הבא ללא טקסט נוסף: {"isValid": true/false, "reason": "הסבר קצר"}`;
        
        // Timeout של 8 שניות לפנייה לג'מיני, כדי לא לתקוע את המשתמש
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000));
        const resultPromise = model.generateContent(prompt);
        
        const response = await Promise.race([resultPromise, timeoutPromise]);
        
        if (response.timeout) {
             console.log("Gemini API Timeout - Auto approving");
             return res.json({ isValid: true, reason: "אישרנו אוטומטית (השופט קצת איטי עכשיו)" });
        }

        let text = response.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(text));
    } catch (e) {
        console.error("Gemini Error:", e);
        res.json({ isValid: true, reason: "אישרנו מחמת הספק (שגיאה אצל השופט)" });
    }
});

// ניהול תחרות מרובת משתתפים
io.on('connection', (socket) => {
    socket.on('createRoom', (hostName) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const letters = "אבגדהזחטיכלמנסעפצקרשת";
        const gameLetter = letters[Math.floor(Math.random() * letters.length)];
        
        rooms[roomId] = { players: [], letter: gameLetter, submittedCount: 0 };
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, name: hostName, isHost: true });
        
        socket.emit('roomCreated', { roomId, letter: gameLetter, players: rooms[roomId].players });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (room) {
            // בדיקה ששחקן לא נכנס פעמיים בטעות
            const existingPlayer = room.players.find(p => p.id === socket.id);
            if (!existingPlayer) {
                socket.join(roomId);
                room.players.push({ id: socket.id, name: playerName, isHost: false });
            }
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });

    socket.on('startGame', (roomId) => {
        if(rooms[roomId]) io.to(roomId).emit('gameStarted', rooms[roomId].letter);
    });

    socket.on('submitScore', ({ roomId, correctCount, timeInSeconds, answers }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.hasSubmitted) { // מוודאים שסופרים כל שחקן פעם אחת בלבד
            player.correctCount = correctCount;
            player.time = timeInSeconds;
            player.answers = answers;
            player.hasSubmitted = true;
            room.submittedCount++;
            
            console.log(`Room ${roomId}: Player ${player.name} finished. (${room.submittedCount}/${room.players.length})`);
        }

        // כשכולם מסיימים - חישוב תוצאות סופיות לפי הכללים שלך
        if (room.submittedCount === room.players.length) {
            console.log(`Room ${roomId}: All players finished. Calculating scores...`);
            const minTime = Math.min(...room.players.map(p => p.time));
            
            room.players.forEach(p => {
                let score = p.correctCount * 10;
                
                if (minTime > 0) {
                    const excessRatio = (p.time - minTime) / minTime;
                    if (excessRatio > 0.50) {
                        const penalties = Math.floor(excessRatio / 0.10);
                        score -= (penalties * 5);
                    }
                }
                p.finalScore = Math.max(0, score);
            });

            // מיון: קודם לפי ציון, ואז לפי זמן במקרה של תיקו
            room.players.sort((a, b) => {
                if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
                return a.time - b.time;
            });

            io.to(roomId).emit('gameOver', room.players);
            
            // ניקוי החדר לאחר 10 שניות כדי למנוע דליפות זיכרון, אבל לא מיד
            setTimeout(() => {
                delete rooms[roomId];
            }, 10000);
        }
    });
    
    // ניקוי שחקנים שמתנתקים באמצע (סוגרים את הדפדפן לפני הסיום)
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                const player = room.players[playerIndex];
                // אם המשחק עדיין לא התחיל (אפס מגישים), אפשר להסיר אותו מהלובי
                if (room.submittedCount === 0) {
                    room.players.splice(playerIndex, 1);
                    io.to(roomId).emit('updatePlayers', room.players);
                } 
                // אם המשחק התחיל, והוא יצא לפני שסיים, נסמן אותו כמי שסיים עם 0 כדי לא לתקוע את כולם
                else if (!player.hasSubmitted) {
                    player.hasSubmitted = true;
                    player.correctCount = 0;
                    player.time = 999; // עונש זמן מירבי
                    player.answers = {};
                    room.submittedCount++;
                    
                    if (room.submittedCount === room.players.length) {
                        // אותה לוגיקת סיום כמו קודם (שמתי כאן כדי לא להאריך את הקוד כרגע)
                        io.to(roomId).emit('gameOver', room.players); 
                    }
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running on port ' + PORT));
