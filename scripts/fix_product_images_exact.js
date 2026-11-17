const { Pool } = require('pg');
require('dotenv').config({ path: 'C:/Users/Usuario/Desktop/frutos-secos-app/backend/.env' });
const fs = require('fs');

function normalize(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function resolveAsset(nombre) {
    const n = normalize(nombre);

    // 1. ACEITES (Prioridad máxima para evitar colisiones con coco, oliva, etc.)
    if (n.includes('aceite')) {
        if (n.includes('almendra')) return '/assets/aceite-almendra.jpg';
        if (n.includes('cannabis')) return '/assets/aceite-cannabis.jpg';
        if (n.includes('chia')) return '/assets/aceite-chia.jpg';
        if (n.includes('coco')) return '/assets/aceite-coco.jpg';
        if (n.includes('jojoba')) return '/assets/aceite-jojoba.jpg';
        if (n.includes('lino')) return '/assets/aceite-lino.jpg';
        if (n.includes('oliva')) return '/assets/aceite-oliva.jpg';
        if (n.includes('oregano')) return '/assets/aceite-oregano.jpg';
        if (n.includes('palta')) return '/assets/aceite-palta.jpg';
        if (n.includes('ricino')) return '/assets/aceite-ricino.jpg';
        if (n.includes('romero')) return '/assets/aceite-romero.jpg';
        if (n.includes('rosa mosqueta')) return '/assets/aceite-rosa-mosqueta.jpg';
        if (n.includes('sesamo')) return '/assets/aceite-sesamo.jpg';
        return '/assets/aceite-oliva.jpg';
    }

    // 2. HARINAS (Prioridad antes de granos/semillas individuales)
    if (n.includes('harina')) {
        if (n.includes('mandioca')) return '/assets/mandioca.jpg';
        if (n.includes('almendra')) return '/assets/harina-almendras.jpg';
        if (n.includes('arroz')) return '/assets/harina-arroz.jpg';
        if (n.includes('avena')) return '/assets/harina-avena.jpg';
        if (n.includes('centeno')) return '/assets/harina-centeno.jpg';
        if (n.includes('garbanzo')) return '/assets/harina-garbanzo.jpg';
        if (n.includes('integral')) return '/assets/harina-integral.jpg';
        if (n.includes('soja')) return '/assets/harina-soja.jpg';
        if (n.includes('coca')) return '/assets/harina-coca.jpg';
        if (n.includes('coco')) return '/assets/harina-coco.jpg';
        if (n.includes('glutinada')) return '/assets/harina-glutinada.jpg';
        if (n.includes('paraguaya')) return '/assets/harina-paraguaya.jpg';
        return '/assets/harina-integral.jpg';
    }

    // 2.1 BANANA CHIPS (Antes de chips de chocolate)
    if (n.includes('banana') && (n.includes('chip') || n.includes('desecada'))) {
        return '/assets/banana-chips.jpg';
    }

    // 3. GALLETAS DE ARROZ (Antes de arroz)
    if (n.includes('galleta') && n.includes('arroz')) {
        if (n.includes('sin sal')) return '/assets/galletas-arroz-sin-sal.jpg';
        if (n.includes('con sal')) return '/assets/galletas-arroz-con-sal.jpg';
        if (n.includes('dulce')) return '/assets/galletas-arroz-dulces.jpg';
        return '/assets/galletas-arroz-sin-sal.jpg';
    }

    // 4. ALMOHADITAS (Antes de frutas o avellanas)
    if (n.includes('almohadita')) return '/assets/almohaditas.jpg';

    // 5. CHOCOLATES ESPECÍFICOS & REPOSTERÍA (Antes de chocolate genérico)
    if (n.includes('mani') && n.includes('chocolate')) return '/assets/mani-chocolate.jpg';
    if (n.includes('almendra') && n.includes('chocolate')) return '/assets/almendras-chocolate.jpg';
    if (n.includes('pasas') && n.includes('chocolate')) return '/assets/pasas-chocolate.jpg';
    if (n.includes('bolita') && n.includes('chocolate')) return '/assets/bolita-chocolate.jpg';
    if (n.includes('chips') && n.includes('blanco')) return '/assets/chips-chocolate-blanco.jpg';
    if (n.includes('chips') || (n.includes('chips') && n.includes('negro'))) return '/assets/chips-chocolate-negro.jpg';
    if (n.includes('esencia') && n.includes('vainilla')) return '/assets/esencia-vainilla.jpg';
    if (n.includes('cereza') && n.includes('glaseada')) return '/assets/cereza-glaseada.jpg';
    if (n.includes('fruta glaseada')) return 'https://www.mayoristadelegumbres.com.ar/wp-content/uploads/2020/11/FRUTA-GLASEADA-1.jpg';
    if (n.includes('fruta escurrida')) return 'https://www.mayoristadelegumbres.com.ar/wp-content/uploads/2020/11/FRUTA-ESCURRIDA.jpg';
    if (n.includes('fruta nevada')) return 'https://frutosare.com.ar/wp-content/uploads/2018/10/fruta-nevada1-61eca53f980489b13416083190228217-640-0-510x382.png';
    if (n.includes('tableta') && n.includes('aguila')) return '/assets/tabletas-aguila.jpg';
    if (n.includes('rocklet')) return '/assets/rocklert.jpg';
    if (n.includes('polvo para hornear') || n.includes('polvo de hornear')) return '/assets/polvo-hornear.jpg';
    if (n.includes('extracto de malta')) return 'https://dieteticaboyaca.com.ar/wp-content/uploads/2024/09/procal-extracto-600x1193-1.jpg';
    if (n.includes('cacao')) return '/assets/cacao-amargo.jpg';
    if (n.includes('coco rallado')) return '/assets/coco-rallado.jpg';
    if (n.includes('chocolate') || n.includes('chocolatina') || n.includes('bombon')) return '/assets/Chocolate.jpg';

    // 6. SEMILLAS (Antes de hierbas)
    if (n.includes('mix de semilla') || n.includes('mix semilla')) return '/assets/mix-semillas.jpg';
    if (n.includes('sesamo') && n.includes('blanco')) return '/assets/sesamo-blanco.jpg';
    if (n.includes('sesamo') && n.includes('integral')) return '/assets/sesamo-integral.jpg';
    if (n.includes('sesamo') && n.includes('negro')) return '/assets/sesamo-negro.jpg';
    if (n.includes('sesamo')) return '/assets/sesamo-integral.jpg';
    if (n.includes('chia')) return '/assets/chia.jpg';
    if (n.includes('girasol')) return '/assets/girasol.jpg';
    if (n.includes('lino')) return '/assets/lino.jpg';
    if (n.includes('amapola')) return '/assets/semilla-amapola.jpg';
    if (n.includes('zapallo')) return '/assets/semilla-zapallo.jpg';

    // 7. FRUTOS SECOS
    if (n.includes('mariposa') && (n.includes('chandler') || n.includes('extra light') || n.includes('2026'))) return '/assets/nuez-mariposa-extra.jpg';
    if (n.includes('mariposa') && (n.includes('ambar') || n.includes('light'))) return '/assets/nuez-ambar.jpg';
    if (n.includes('nuez') && n.includes('cuarto')) return '/assets/nuez-cuarto.jpg';
    if (n.includes('nuez') && n.includes('cascara')) return '/assets/nuez-con-cascara.jpg';
    if (n.includes('nuez') && n.includes('moscada')) return '/assets/nuez-moscada.jpg';
    if (n.includes('nueces chandler')) return '/assets/nuez-mariposa-extra.jpg';

    if (n.includes('almendra') && (n.includes('chilen') || n.includes('non pareil') || n.includes('carmel'))) return '/assets/Almendras-Chilenas.jpg';
    if (n.includes('almendra') && n.includes('guara')) return '/assets/almendras-guara.jpg';

    if (n.includes('caju') || n.includes('castanas de caju')) return '/assets/castanas-caju.jpg';
    if (n.includes('castana') && (n.includes('para') || n.includes('pará'))) return '/assets/castanas-de-para.jpg';
    if (n.includes('castana') && n.includes('india')) return '/assets/castanas-india.jpg';

    if (n.includes('avellana')) return '/assets/avellanas.jpg';
    if (n.includes('pistacho') && (n.includes('sin cascara') || n.includes('pelado'))) return '/assets/pistacho-sin-cascara.jpg';
    if (n.includes('pistacho')) return '/assets/Pistacho.jpg';

    if (n.includes('pasas') && n.includes('jumbo')) return '/assets/pasas-jumbo.jpg';
    if (n.includes('pasas') && (n.includes('flame') || n.includes('sultanina') || n.includes('morocha'))) return '/assets/pasas-sultaninas.jpg';
    if (n.includes('pasas') && n.includes('rubia')) return '/assets/pasas-rubias.jpg';

    if (n.includes('ciruela')) return '/assets/ciruela-sin-carozo.jpg';
    if (n.includes('arandano')) return '/assets/arandanos.jpg';
    if (n.includes('banana') && (n.includes('chip') || n.includes('desecada'))) return '/assets/banana-chips.jpg';
    if (n.includes('datil')) return '/assets/datiles.jpg';
    if (n.includes('higo')) return '/assets/higos-negros.jpg';
    if (n.includes('pasta de mani') || n.includes('entrenuts')) return '/assets/pasta-mani.jpg';

    // 8. MIXES
    if (n.includes('mix pan dulce')) return 'https://oestedistribucion.com.ar/wp-content/uploads/2024/02/WhatsApp-Image-2024-04-08-at-15.18.59.jpeg';
    if (n.includes('mix patagonia')) return '/assets/Mix Patagonia.jpg';
    if (n.includes('mix premium')) return '/assets/Mix Premium.jpg';
    if (n.includes('mix fruta') && n.includes('sin mani')) return '/assets/Mix Frutas Sin Mani.jpg';
    if (n.includes('mix sin pasas')) return '/assets/mix-sin-pasas.jpg';
    if (n.includes('mix banana') || n.includes('mix bananaa')) return '/assets/mix-banana.jpg';
    if (n.includes('mix tropical')) return '/assets/mix-tropical.jpg';
    if (n.includes('mix economico')) return '/assets/mix-economico.jpg';
    if (n.includes('mix cervecero')) return '/assets/mix-cervecero.jpg';

    // 9. CEREALES & SNACKS
    if (n.includes('quinoa pop')) return '/assets/quinoa-pop.jpg';
    if (n.includes('quinoa')) return '/assets/quinoa.jpg';
    if (n.includes('arito frutal')) return '/assets/arito-frutal.jpg';
    if (n.includes('tomate seco')) return '/assets/tomates-secos.jpg';
    if (n.includes('fibra de salvado')) return '/assets/fibra-salvado.jpg';
    if (n.includes('granola')) return '/assets/granola.jpg';
    if (n.includes('copos')) return '/assets/copos.jpg';
    if (n.includes('tutuca')) return '/assets/tutuca.jpg';
    if (n.includes('palito salado')) return '/assets/palito-salado.jpg';
    if (n.includes('maiz frito') || n.includes('maiz salado')) return '/assets/maiz-frito.jpg';
    if (n.includes('garrapinada')) return '/assets/garrapinadas.jpg';
    if (n.includes('mani') && (n.includes('saborizado') || n.includes('chino') || n.includes('crocante'))) return '/assets/mani-chino.jpg';
    if (n.includes('mani') && (n.includes('vaina') || n.includes('cascara'))) return '/assets/mani-vaina.jpg';
    if (n.includes('mani') && (n.includes('salado') || n.includes('repelado') || n.includes('sin sal') || n.includes('tostado'))) return '/assets/mani-salado.jpg';

    // 10. LEGUMBRES & ARROCES
    if (n.includes('lentejon')) return '/assets/lentejon.jpg';
    if (n.includes('lenteja')) return '/assets/lenteja.jpg';
    if (n.includes('poroto alubia')) return '/assets/poroto-alubia.jpg';
    if (n.includes('poroto colorado')) return '/assets/poroto-colorado.jpg';
    if (n.includes('poroto aduki')) return '/assets/poroto-aduki.jpg';
    if (n.includes('poroto negro')) return '/assets/poroto-negro.jpg';
    if (n.includes('poroto pallares')) return '/assets/poroto-pallares.jpg';
    if (n.includes('poroto soja')) return '/assets/poroto-soja.jpg';
    if (n.includes('arroz yamani')) return '/assets/arroz-yamani.jpg';
    if (n.includes('arroz')) return '/assets/arroz-integral.jpg';
    if (n.includes('pisingallo')) return '/assets/pisingallo.jpg';
    if (n.includes('garbanzo')) return '/assets/garbanzo.jpg';
    if (n.includes('avena')) return '/assets/avena.jpg';
    if (n.includes('soja texturizada')) return '/assets/soja-texturizada.jpg';
    if (n.includes('salvado de trigo')) return '/assets/salvado-trigo.jpg';
    if (n.includes('semolin')) return '/assets/semolin.jpg';
    if (n.includes('semola')) return '/assets/semola.jpg';
    if (n.includes('maizena')) return '/assets/maizena.jpg';
    if (n.includes('mandioca')) return '/assets/mandioca.jpg';

    // 11. CONDIMENTOS
    if (n.includes('sal de himalaya') || n.includes('himalaya')) return '/assets/sal-himalaya.jpg';
    if (n.includes('sal marina')) return '/assets/sal-marina.jpg';
    if (n.includes('bicarbonato')) return '/assets/bicarbonato.jpg';
    if (n.includes('gelatina') && !n.includes('agar')) return '/assets/gelatina.jpg';
    if (n.includes('oregano')) return '/assets/oregano.jpg';
    if (n.includes('provenzal')) return '/assets/provenzal.jpg';
    if (n.includes('adobo')) return '/assets/adobo-pizza.jpg';
    if (n.includes('pimenton ahumado')) return '/assets/pimenton-ahumado.jpg';
    if (n.includes('pimenton')) return '/assets/pimenton.jpg';
    if (n.includes('canela en rama')) return '/assets/canela-en-rama.jpg';
    if (n.includes('canela')) return '/assets/canela.jpg';
    if (n.includes('pimienta blanca')) return '/assets/pimienta-blanca.jpg';
    if (n.includes('pimienta negra') && n.includes('grano')) return '/assets/pimienta-negra-granos.jpg';
    if (n.includes('pimienta negra') || n.includes('pimienta')) return '/assets/pimienta-negra.jpg';
    if (n.includes('ajo en polvo')) return '/assets/ajo-polvo.jpg';
    if (n.includes('ajo triturado') || n.includes('ajo')) return '/assets/ajo-triturado.jpg';
    if (n.includes('aji puro') || n.includes('aji')) return '/assets/aji-puro.jpg';
    if (n.includes('jengibre')) return '/assets/jengibre.jpg';
    if (n.includes('comino')) return '/assets/comino.jpg';
    if (n.includes('curcuma')) return '/assets/curcuma.jpg';
    if (n.includes('anis estrellado')) return '/assets/anis-estrellado.jpg';
    if (n.includes('anis en grano') || n.includes('anis')) return '/assets/anis-en-grano.jpg';
    if (n.includes('paprika')) return '/assets/paprika.jpg';
    if (n.includes('curry')) return '/assets/curry.jpg';
    if (n.includes('chimichurri')) return '/assets/chimichurri.jpg';
    if (n.includes('clavo de olor') || n.includes('clavo')) return '/assets/clavo-de-olor.jpg';

    // 12. AZÚCARES & ENDULZANTES
    if (n.includes('azucar impalpable')) return '/assets/azucar-impalpable.jpg';
    if (n.includes('azucar mascabo')) return '/assets/azucar-mascabo.jpg';
    if (n.includes('azucar rubia')) return '/assets/azucar-rubia.jpg';
    if (n.includes('azucar negra')) return '/assets/azucar-negra.jpg';
    if (n.includes('eritritol') && n.includes('stevia')) return '/assets/EritritolStevia.jpg';
    if (n.includes('eritritol')) return '/assets/Eritritol200.jpg';
    if (n.includes('miel')) return '/assets/Miel Pura X 1KG.jfif';

    // 13. SUPLEMENTOS
    if (n.includes('colageno')) return '/assets/colageno.jpg';
    if (n.includes('cartilago')) return '/assets/cartilago-tiburon.jpg';
    if (n.includes('maca')) return '/assets/maca.jpg';
    if (n.includes('iron bar')) return '/assets/iron-bar.jpg';
    if (n.includes('honey del amor')) return '/assets/honey-del-amor.jpg';
    if (n.includes('huang he')) return '/assets/huang-he.jpg';
    if (n.includes('pum pum')) return '/assets/pum-pum.jpg';
    if (n.includes('agar agar')) return '/assets/agar-agar.jpg';
    if (n.includes('goma xantica')) return '/assets/goma-xantica.jpg';

    // 14. HERBORISTERÍA
    if (/\bsen\b|\bsem\b/i.test(n) && !n.includes('esencia') && !n.includes('semilla')) return '/assets/sen.jpg';
    if (n.includes('ginkgo') || n.includes('gingko')) return '/assets/gingko-biloba.jpg';
    if (n.includes('moringa')) return '/assets/moringa.jpg';
    if (n.includes('rosa mosqueta')) return '/assets/rosa-mosqueta.jpg';
    if (n.includes('cascara sagrada')) return '/assets/cascara-sagrada.jpg';
    if (n.includes('graviola')) return '/assets/graviola.jpg';
    if (n.includes('manzanilla')) return '/assets/manzanilla.jpg';
    if (n.includes('petalo') || n.includes('rosas')) return '/assets/petalo-rosas.jpg';
    if (n.includes('sandalo')) return '/assets/sandalo.jpg';
    if (n.includes('siempre viva')) return '/assets/siempre-viva.jpg';
    if (n.includes('tilo') || n.includes('flor de tilo')) return '/assets/tilo.jpg';
    if (n.includes('valeriana')) return '/assets/valeriana.jpg';
    if (n.includes('cedron')) return '/assets/cedron.jpg';
    if (n.includes('laurel')) return '/assets/laurel.jpg';
    if (n.includes('hammamelis')) return '/assets/hammamelis.jpg';
    if (n.includes('higuera')) return '/assets/higuera-tintura.jpg';
    if (n.includes('malva')) return '/assets/malva.jpg';
    if (n.includes('melisa')) return '/assets/melisa.jpg';
    if (n.includes('lapacho')) return '/assets/lapacho.jpg';
    if (n.includes('llanten')) return '/assets/llanten-tintura.jpg';
    if (n.includes('menta')) return '/assets/menta.jpg';
    if (n.includes('muna muna')) return '/assets/muna-muna.jpg';
    if (n.includes('ortiga')) return '/assets/ortiga.jpg';
    if (n.includes('salvia blanca')) return '/assets/salvia-blanca.jpg';
    if (n.includes('salvia')) return '/assets/salvia.jpg';
    if (n.includes('poleo')) return '/assets/poleo.jpg';
    if (n.includes('romero')) return '/assets/romero-tintura.jpg';
    if (n.includes('peperina')) return '/assets/peperina.jpg';
    if (n.includes('pasionaria')) return '/assets/pasionaria.jpg';
    if (n.includes('te negro')) return '/assets/te-negro.jpg';
    if (n.includes('te rojo')) return '/assets/te-rojo.jpg';
    if (n.includes('te verde')) return '/assets/te-verde.jpg';
    if (n.includes('marcela')) return '/assets/marcela.jpg';
    if (n.includes('pesuna') || n.includes('pezuña')) return '/assets/pesuna-de-vaca.jpg';
    if (n.includes('rompe piedra') && n.includes('tintura')) return '/assets/rompe-piedra-tintura.jpg';
    if (n.includes('rompe piedra')) return '/assets/rompe-piedra.jpg';
    if (n.includes('ajenjo')) return '/assets/ajenjo.jpg';
    if (n.includes('alcachofa')) return '/assets/alcachofa.jpg';
    if (n.includes('amargon') || n.includes('chicoria')) return '/assets/amargon.jpg';
    if (n.includes('ambay')) return '/assets/ambay.jpg';
    if (n.includes('burrito')) return '/assets/burrito.jpg';
    if (n.includes('boldo')) return '/assets/boldo.jpg';
    if (n.includes('carqueja')) return '/assets/carqueja.jpg';
    if (n.includes('cola de caballo')) return '/assets/cola-de-caballo.jpg';
    if (n.includes('quirquincho')) return '/assets/cola-de-quirquincho.jpg';
    if (n.includes('chanar')) return '/assets/chanar-tintura.jpg';
    if (n.includes('calendula')) return '/assets/calendula.jpg';
    if (n.includes('diente de leon')) return '/assets/diente-de-leon-tintura.jpg';
    if (n.includes('espina colorada')) return '/assets/espina-colorada.jpg';
    if (n.includes('doradilla')) return '/assets/doradilla.jpg';
    if (n.includes('estigma de maiz')) return '/assets/estigma-de-maiz.jpg';
    if (n.includes('eucalipto')) return '/assets/eucalipto.jpg';
    if (n.includes('cardo mariano')) return '/assets/cardo-mariano.jpg';
    if (n.includes('hisopo')) return '/assets/hisopo.jpg';
    if (n.includes('palo amarillo')) return '/assets/palo-amarillo.jpg';
    if (n.includes('hierbabuena')) return '/assets/hierbabuena.jpg';
    if (n.includes('yerba de pollo')) return '/assets/yerba-de-pollo.jpg';
    if (n.includes('mirra')) return '/assets/mirra.jpg';
    if (n.includes('jamaica')) return '/assets/flor-jamaica.jpg';

    return null;
}

async function fixExact() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const prods = (await pool.query('SELECT id, codigo, nombre, imagen FROM productos WHERE activo = true ORDER BY id ASC')).rows;

    let dbFixes = 0;
    for (const p of prods) {
        const correct = resolveAsset(p.nombre);
        if (correct && correct !== p.imagen) {
            console.log(`[DB FIX ${p.id}] ${p.nombre}:\n   ${p.imagen}  ==>  ${correct}`);
            await pool.query('UPDATE productos SET imagen = $1 WHERE id = $2', [correct, p.id]);
            dbFixes++;
        }
    }
    pool.end();
    console.log(`Corregidos en PostgreSQL: ${dbFixes}`);

    // Corregir catalogo_completo.json
    const catPath = 'C:/Users/Usuario/Desktop/frutos-secos-app/frontend/src/data/catalogo_completo.json';
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));

    let catFixes = 0;
    cat.productos.forEach(cp => {
        const correct = resolveAsset(cp.nombre);
        if (correct && correct !== cp.imagen) {
            console.log(`[CAT FIX ${cp.id}] ${cp.nombre}:\n   ${cp.imagen}  ==>  ${correct}`);
            cp.imagen = correct;
            catFixes++;
        }
    });

    fs.writeFileSync(catPath, JSON.stringify(cat, null, 2), 'utf8');
    console.log(`Corregidos en catalogo_completo.json: ${catFixes}`);
}

fixExact().catch(console.error);
