const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { SECRET } = require('./middleware/auth');

let io = null;

// Mapa de usuarios actualmente conectados a la red: userId -> { socketId, nombre, email, rol, lastSeen }
const usuariosConectados = new Map();

function initSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
        }
    });

    // Middleware de autenticación por JWT
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (token) {
            try {
                const payload = jwt.verify(token, SECRET);
                socket.usuario = payload;
            } catch (err) {
                console.warn('[Socket.io] Conexión con token inválido o expirado:', err.message);
            }
        }
        next();
    });

    io.on('connection', (socket) => {
        const u = socket.usuario;
        if (u && u.id) {
            usuariosConectados.set(u.id, {
                socketId: socket.id,
                usuarioId: u.id,
                nombre: u.nombre,
                email: u.email,
                rol: u.rol,
                conectadoDesde: new Date()
            });
            console.log(`🔌 [Socket.io] Operario/Usuario online: ${u.nombre} (${u.rol}) [ID: ${socket.id}]`);
            // Notificar a todos la lista actualizada de usuarios conectados
            emitirUsuariosOnline();
        }

        socket.join('deposito');
        socket.join('jarvis_network');

        socket.on('join:room', (room) => {
            if (room) socket.join(room);
        });

        // Respuesta del destinatario a una consulta de Jarvis
        socket.on('jarvis:responder_consulta', async (data) => {
            try {
                const { consulta_id, respuesta } = data;
                const db = require('./db/pool');
                await db.run(`
                    UPDATE jarvis_consultas_equipo
                    SET respuesta = $1, estado = 'respondida', answered_at = NOW()
                    WHERE id = $2
                `, [respuesta, consulta_id]);

                const consulta = await db.one('SELECT * FROM jarvis_consultas_equipo WHERE id = $1', [consulta_id]);
                if (consulta) {
                    // Notificar a toda la red que Jarvis recibió la respuesta
                    io.emit('jarvis:consulta_respondida', consulta);
                }
            } catch (err) {
                console.error('Error al guardar respuesta en jarvis:', err);
            }
        });

        socket.on('disconnect', () => {
            if (u && u.id) {
                usuariosConectados.delete(u.id);
                console.log(`🔌 [Socket.io] Desconectado: ${u.nombre}`);
                emitirUsuariosOnline();
            }
        });
    });

    return io;
}

function getIO() {
    return io;
}

function emitirUsuariosOnline() {
    if (!io) return;
    const lista = Array.from(usuariosConectados.values()).map(u => ({
        id: u.usuarioId,
        nombre: u.nombre,
        email: u.email,
        rol: u.rol,
        conectadoDesde: u.conectadoDesde
    }));
    io.emit('jarvis:usuarios_online', lista);
}

function getUsuariosConectados() {
    return Array.from(usuariosConectados.values());
}

/**
 * Emite un evento a todos los clientes o específicamente al room de depósito
 */
function emitirEventoDeposito(evento, datos) {
    if (!io) return;
    io.to('deposito').emit(evento, datos);
    io.emit(evento, datos);
}

/**
 * Envía una consulta que Jarvis hace a un miembro del equipo conectado
 */
function emitirConsultaJarvisAEquipo(consulta) {
    if (!io) return;
    io.emit('jarvis:nueva_consulta_equipo', consulta);
}

module.exports = {
    initSocket,
    getIO,
    emitirEventoDeposito,
    getUsuariosConectados,
    emitirConsultaJarvisAEquipo
};
