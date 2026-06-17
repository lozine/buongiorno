const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7 }); 

app.use(express.static(path.join(__dirname, 'public')));

const db = {
    users: {},    
    friends: {},  
    chats: {}     
};

const onlineUsers = {}; // { socketId: username_lowercase }
const activeChats = {}; // { socketId: friend_username_lowercase }

io.on('connection', (socket) => {
    console.log(`Socket connesso: ${socket.id}`);

    socket.on('authenticate', ({ username, password, avatar, isRegistering }, callback) => {
        const cleanedName = username.trim();
        const lowerName = cleanedName.toLowerCase();
        const userExists = db.users[lowerName];

        if (isRegistering) {
            if (userExists) {
                return callback({ success: false, error: "Questo username è già registrato." });
            }
            db.users[lowerName] = { username: cleanedName, password, avatar };
            db.friends[lowerName] = {};
            db.chats[lowerName] = {};
        } else {
            if (!userExists) {
                return callback({ success: false, error: "Username non trovato." });
            }
            if (userExists.password !== password) {
                return callback({ success: false, error: "Password errata." });
            }
        }

        const isAlreadyOnline = Object.values(onlineUsers).includes(lowerName);
        if (isAlreadyOnline) {
            return callback({ success: false, error: "Questo utente è già online altrove." });
        }

        onlineUsers[socket.id] = lowerName;
        socket.join(lowerName);

        callback({ 
            success: true, 
            user: { 
                username: db.users[lowerName].username, 
                avatar: db.users[lowerName].avatar 
            } 
        });

        io.emit('global_status_change');
    });

    socket.on('update_full_profile', ({ newUsername, oldPassword, newPassword, avatar }, callback) => {
        const currentLower = onlineUsers[socket.id];
        if (!currentLower || !db.users[currentLower]) {
            return callback({ success: false, error: "Sessione non autorizzata." });
        }

        const userRecord = db.users[currentLower];

        if (oldPassword || newPassword) {
            if (userRecord.password !== oldPassword) {
                return callback({ success: false, error: "La vecchia password non è corretta." });
            }
            userRecord.password = newPassword;
        }

        const cleanedNewName = newUsername.trim();
        const newLower = cleanedNewName.toLowerCase();

        if (currentLower !== newLower) {
            if (db.users[newLower]) {
                return callback({ success: false, error: "Il nuovo username è occupato." });
            }
            db.users[newLower] = userRecord;
            delete db.users[currentLower];

            db.friends[newLower] = db.friends[currentLower];
            delete db.friends[currentLower];

            db.chats[newLower] = db.chats[currentLower];
            delete db.chats[currentLower];
        }

        db.users[newLower].username = cleanedNewName;
        db.users[newLower].avatar = avatar;
        
        onlineUsers[socket.id] = newLower;
        socket.leave(currentLower);
        socket.join(newLower);

        callback({ success: true, user: { username: cleanedNewName, avatar: avatar } });
        io.emit('global_status_change');
    });

    socket.on('search_user_preview', (targetName, callback) => {
        const targetLower = targetName.trim().toLowerCase();
        const targetUser = db.users[targetLower];
        
        if (!targetUser) return callback({ success: false, error: "Utente non trovato." });
        
        callback({ 
            success: true, 
            user: { username: targetUser.username, avatar: targetUser.avatar } 
        });
    });

    socket.on('send_friend_request', (targetName, callback) => {
        const senderLower = onlineUsers[socket.id];
        if (!senderLower) return callback({ success: false, error: "Sessione scaduta." });

        const targetLower = targetName.trim().toLowerCase();
        
        if (senderLower === targetLower) return callback({ success: false, error: "Non puoi aggiungere te stesso." });

        const senderProfile = db.users[senderLower];
        const targetProfile = db.users[targetLower];

        db.friends[senderLower][targetLower] = {
            username: targetProfile.username,
            avatar: targetProfile.avatar,
            isRequest: false,
            isSentRequest: true
        };

        db.friends[targetLower][senderLower] = {
            username: senderProfile.username,
            avatar: senderProfile.avatar,
            isRequest: true,
            isSentRequest: false
        };

        io.to(targetLower).emit('sync_database_update');
        callback({ success: true });
    });

    socket.on('cancel_sent_request', (targetName) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const targetLower = targetName.toLowerCase();

        if (db.friends[myLower]) delete db.friends[myLower][targetLower];
        if (db.friends[targetLower]) delete db.friends[targetLower][myLower];

        io.to(targetLower).emit('sync_database_update');
        socket.emit('sync_database_update');
    });

    socket.on('respond_friend_request', ({ senderName, accept }) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const senderLower = senderName.toLowerCase();

        if (accept) {
            if (db.friends[myLower][senderLower]) db.friends[myLower][senderLower].isRequest = false;
            if (db.friends[senderLower][myLower]) db.friends[senderLower][myLower].isSentRequest = false;
        } else {
            delete db.friends[myLower][senderLower];
            delete db.friends[senderLower][myLower];
        }

        io.to(senderLower).emit('sync_database_update');
        socket.emit('sync_database_update');
    });

    socket.on('remove_friend', (friendName) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const friendLower = friendName.toLowerCase();

        if (db.friends[myLower]) delete db.friends[myLower][friendLower];
        if (db.friends[friendLower]) delete db.friends[friendLower][myLower];

        io.to(friendLower).emit('sync_database_update');
        socket.emit('sync_database_update');
    });

    socket.on('request_db_sync', (callback) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return callback({ friends: {}, chats: {} });
        callback({
            friends: db.friends[myLower] || {},
            chats: db.chats[myLower] || {}
        });
    });

    // Registra quale chat l'utente sta guardando al momento
    socket.on('set_active_chat', (friendName) => {
        if (friendName) {
            activeChats[socket.id] = friendName.toLowerCase();
            // Segna come letti i messaggi quando apri la chat
            const myLower = onlineUsers[socket.id];
            const targetLower = friendName.toLowerCase();
            if (myLower && db.chats[myLower] && db.chats[myLower][targetLower]) {
                db.chats[myLower][targetLower].forEach(m => {
                    if (m.sender === 'them') m.read = true;
                });
                if (db.chats[targetLower] && db.chats[targetLower][myLower]) {
                    db.chats[targetLower][myLower].forEach(m => {
                        if (m.sender === 'me') m.read = true;
                    });
                }
                io.to(targetLower).emit('sync_database_update');
            }
        } else {
            delete activeChats[socket.id];
        }
    });

    // LOGICA AVANZATA DELLE SPUNTE
    socket.on('send_private_message', ({ to, message }) => {
        const senderLower = onlineUsers[socket.id];
        if (!senderLower) return;

        const targetLower = to.toLowerCase();
        
        if (!db.chats[senderLower][targetLower]) db.chats[senderLower][targetLower] = [];
        if (!db.chats[targetLower][senderLower]) db.chats[targetLower][senderLower] = [];

        // Verifica stati dell'interlocutore per determinare le spunte
        const isTargetOnline = Object.values(onlineUsers).includes(targetLower);
        
        let targetSocketId = null;
        for (const [sId, uName] of Object.entries(onlineUsers)) {
            if (uName === targetLower) { targetSocketId = sId; break; }
        }
        
        const isTargetOnThisChat = targetSocketId && activeChats[targetSocketId] === senderLower;

        let statusSpunta = 'sent_offline'; // 1 Spunta Grigia
        if (isTargetOnline) {
            statusSpunta = isTargetOnThisChat ? 'read_blue' : 'delivered_online'; // 2 Blu o 2 Grigie
        }

        const msgForMe = { sender: 'me', ...message, spunteState: statusSpunta, read: (statusSpunta === 'read_blue') };
        const msgForThem = { sender: 'them', ...message, spunteState: statusSpunta, read: (statusSpunta === 'read_blue') };

        db.chats[senderLower][targetLower].push(msgForMe);
        db.chats[targetLower][senderLower].push(msgForThem);

        io.to(targetLower).emit('receive_private_message', {
            sender: db.users[senderLower].username,
            message: msgForThem
        });
        
        socket.emit('sync_database_update');
    });

    socket.on('clear_chat_history', (targetName) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const targetLower = targetName.toLowerCase();

        if (db.chats[myLower] && db.chats[myLower][targetLower]) {
            db.chats[myLower][targetLower] = [];
        }
        socket.emit('sync_database_update');
    });

    // LOGICA ASIMMETRICA DI ELIMINAZIONE MESSAGGIO
    socket.on('delete_single_message', ({ friendName, msgId }) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const targetLower = friendName.toLowerCase();

        if (db.chats[myLower] && db.chats[myLower][targetLower]) {
            const foundMsg = db.chats[myLower][targetLower].find(m => m.id === msgId);
            if (foundMsg) {
                if (foundMsg.sender === 'me') {
                    // È mio: eliminalo per tutti (sia da me che dall'altro)
                    db.chats[myLower][targetLower] = db.chats[myLower][targetLower].filter(m => m.id !== msgId);
                    if (db.chats[targetLower] && db.chats[targetLower][myLower]) {
                        db.chats[targetLower][myLower] = db.chats[targetLower][myLower].filter(m => m.id !== msgId);
                    }
                    io.to(targetLower).emit('sync_database_update');
                } else {
                    // È dell'altro: lo cancello solo dal mio schermo
                    db.chats[myLower][targetLower] = db.chats[myLower][targetLower].filter(m => m.id !== msgId);
                }
            }
        }
        socket.emit('sync_database_update');
    });

    socket.on('message_read_receipt', ({ msgId, fromUser }) => {
        const myLower = onlineUsers[socket.id];
        if (!myLower) return;
        const targetLower = fromUser.toLowerCase();

        if (db.chats[targetLower] && db.chats[targetLower][myLower]) {
            const msg = db.chats[targetLower][myLower].find(m => m.id === msgId);
            if (msg) { msg.read = true; msg.spunteState = 'read_blue'; }
        }
        if (db.chats[myLower] && db.chats[myLower][targetLower]) {
            const msg = db.chats[myLower][targetLower].find(m => m.id === msgId);
            if (msg) { msg.read = true; msg.spunteState = 'read_blue'; }
        }

        io.to(targetLower).emit('message_status_updated', { msgId, viewer: myLower });
    });

    socket.on('get_online_statuses', (callback) => {
        callback(Object.values(onlineUsers));
    });

    socket.on('disconnect', () => {
        delete onlineUsers[socket.id];
        delete activeChats[socket.id];
        io.emit('global_status_change');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[NexusChat] Online su http://localhost:${PORT}`));