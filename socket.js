const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { SECRET } = require('./middleware/auth');

let io = null;

function initSocket(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
        }
    });

    // Middleware de autenticación por JWT opcional/seguro
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
        const u = socket.usuario ? `${socket.usuario.nombre} (${socket.usuario.rol})` : 'Anónimo';
        console.log(`🔌 [Socket.io] Operario/Cliente conectado: ${u} [ID: ${socket.id}]`);

        // Unirse a salas específicas
        socket.join('deposito');

        socket.on('join:room', (room) => {
            if (room) socket.join(room);
        });

        socket.on('disconnect', () => {
            // Desconexión limpia
        });
    });

    return io;
}

function getIO() {
    return io;
}

/**
 * Emite un evento a todos los clientes o específicamente al room de depósito
 * @param {string} evento Nombre del evento (ej: 'kanban:actualizado', 'remito:asignado')
 * @param {object} datos Carga útil del evento
 */
function emitirEventoDeposito(evento, datos) {
    if (!io) return;
    io.to('deposito').emit(evento, datos);
    io.emit(evento, datos); // broadcast general
}

module.exports = {
    initSocket,
    getIO,
    emitirEventoDeposito
};
