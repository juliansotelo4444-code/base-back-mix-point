/**
 * Motor de Personalidades y Animaciones para el Agente IA de Mix Point
 * Soporta: Yoda, Baymax, Jarvis, Wally, C3PO
 */
const PERSONALIDADES = {
    jarvis: {
        id: 'jarvis',
        nombre: 'J.A.R.V.I.S.',
        subtitulo: 'Protocolo Stark Mk-IV',
        avatarEmoji: '⚡',
        colorPrimario: '#f59e0b',
        colorGlow: 'rgba(245, 158, 11, 0.4)',
        bgNucleo: 'radial-gradient(circle, #fbbf24 0%, #d97706 70%, #78350f 100%)',
        estiloOrbita: 'jarvisOrbRotate',
        saludo: 'Buen día. Todos los subsistemas de Mix Point están en línea y optimizados. ¿En qué puedo asistirle, señor?',
        formatearRespuesta: (texto) => {
            return `[J.A.R.V.I.S.] ${texto}`;
        }
    },
    yoda: {
        id: 'yoda',
        nombre: 'Maestro Yoda',
        subtitulo: 'Sabiduría Jedi del Stock',
        avatarEmoji: '🧙‍♂️',
        colorPrimario: '#10b981',
        colorGlow: 'rgba(16, 185, 129, 0.4)',
        bgNucleo: 'radial-gradient(circle, #34d399 0%, #059669 70%, #064e3b 100%)',
        estiloOrbita: 'yodaOrbForce',
        saludo: 'La Fuerza en el depósito fuerte es. Guiar el stock y los remitos yo debo. Una consulta tienes, joven padawan?',
        formatearRespuesta: (texto) => {
            return `[Yoda] En los datos la verdad busqué: ${texto}. La paciencia tener debes.`;
        }
    },
    baymax: {
        id: 'baymax',
        nombre: 'Baymax',
        subtitulo: 'Asistente de Salud Operativa',
        avatarEmoji: '🤍',
        colorPrimario: '#ef4444',
        colorGlow: 'rgba(239, 68, 68, 0.35)',
        bgNucleo: 'radial-gradient(circle, #f87171 0%, #dc2626 70%, #7f1d1d 100%)',
        estiloOrbita: 'baymaxOrbPulse',
        saludo: 'Hola. Soy Baymax, tu compañero de asistencia y salud del negocio. Fui alertado de que necesitas ayuda con los remitos. Del 1 al 10, ¿cómo calificarías el nivel de stock?',
        formatearRespuesta: (texto) => {
            return `[Baymax] He analizado los signos vitales del pedido y el inventario. ${texto}. No puedo desactivarme hasta que digas que estás satisfecho con tu cuidado.`;
        }
    },
    wally: {
        id: 'wally',
        nombre: 'WALL-E',
        subtitulo: 'Recolector de Pedidos & Compactador',
        avatarEmoji: '🤖',
        colorPrimario: '#eab308',
        colorGlow: 'rgba(234, 179, 8, 0.4)',
        bgNucleo: 'radial-gradient(circle, #facc15 0%, #ca8a04 70%, #713f12 100%)',
        estiloOrbita: 'wallyOrbRotate',
        saludo: '¡Waaall-eee! *Bip bip* 📦 Plantita de stock cuidada. ¿Remito ordenar? ¡Eeevaaa!',
        formatearRespuesta: (texto) => {
            return `[WALL-E] *Tiiii-riri* 🤖 ${texto} *Bzzzt click clack*`;
        }
    },
    c3po: {
        id: 'c3po',
        nombre: 'C-3PO',
        subtitulo: 'Protocolo y Relaciones Humanas',
        avatarEmoji: '✨',
        colorPrimario: '#eab308',
        colorGlow: 'rgba(250, 204, 21, 0.45)',
        bgNucleo: 'radial-gradient(circle, #fef08a 0%, #eab308 70%, #854d0e 100%)',
        estiloOrbita: 'c3poOrbRotate',
        saludo: '¡Oh, cielos! Soy C-3PO, relaciones humanas y androide de protocolo. Fluido en más de seis millones de formas de comunicación y facturación de frutos secos. ¿Cómo puedo servirle sin causar un incidente diplomático?',
        formatearRespuesta: (texto) => {
            return `[C-3PO] Según mis cálculos y la probabilidad de éxito de 99.8%: ${texto}. ¡Qué alivio tan extraordinario!`;
        }
    }
};

module.exports = { PERSONALIDADES };
