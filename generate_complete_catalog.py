import pymupdf
import json
import re
import os
import unicodedata

pdf_path = r"C:\Users\Usuario\Downloads\Catalogo-MixPoint.pdf"
doc = pymupdf.open(pdf_path)

frontend_data_dir = r"C:\Users\Usuario\Desktop\frutos-secos-app\frontend\src\data"
backend_data_dir = r"C:\Users\Usuario\Desktop\frutos-secos-app\backend\data"
img_out_dir = r"C:\Users\Usuario\Desktop\frutos-secos-app\frontend\public\catalogo\productos"

os.makedirs(frontend_data_dir, exist_ok=True)
os.makedirs(backend_data_dir, exist_ok=True)
os.makedirs(img_out_dir, exist_ok=True)

categories_map = {
    3: "Frutos Secos",
    4: "Frutos Secos",
    5: "Mixes",
    6: "Cereales",
    7: "Repostería",
    8: "Snacks",
    9: "Legumbres",
    10: "Condimentos",
    11: "Condimentos",
    12: "Azúcares",
    13: "Harinas",
    14: "Semillas",
    15: "Suplementos",
    16: "Aceites",
    17: "Otros",
    18: "Chocolates sin TACC",
    19: "Herboristería",
    20: "Herboristería",
    21: "Herboristería"
}

def clean_text(s):
    if not s:
        return ""
    res = s.strip()
    # Replace unicode replacement char or missing glyphs
    replacements = [
        ('\ufffd', 'ñ'),
        ('Castaas', 'Castañas'),
        ('Castañas de Pará', 'Castañas de Pará'),
        ('anan', 'ananá'),
        ('ssamo', 'sésamo'),
        ('chia', 'chía'),
        ('mani', 'maní'),
        ('oregano', 'orégano'),
        ('azucar', 'azúcar'),
        ('maiz', 'maíz'),
        ('Muna Muna', 'Muña Muña'),
        ('Muña Muna', 'Muña Muña'),
        ('Muna Muña', 'Muña Muña'),
        ('Una De Gato', 'Uña De Gato'),
        ('Cedo', 'Cedrón'),
        ('po 1kg', 'x 1kg'),
        ('po1 kg', 'x 1kg'),
        ('por 1 kg', 'x 1kg'),
        ('por 1kg', 'x 1kg'),
    ]
    for k, v in replacements:
        res = res.replace(k, v)
    return res

def parse_price(val_str):
    cleaned = re.sub(r'[^\d]', '', val_str)
    try:
        return float(cleaned)
    except:
        return 0.0

def slugify(text):
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('utf-8')
    text = re.sub(r'[^\w\s-]', '', text.lower()).strip()
    return re.sub(r'[-\s]+', '_', text)

all_products = []
saved_images = {}

for page_idx in range(2, len(doc)):
    page_num = page_idx + 1
    category = categories_map.get(page_num, "General")
    page = doc[page_idx]
    
    # Collect images
    page_images = []
    for img_info in page.get_images():
        xref = img_info[0]
        rects = page.get_image_rects(xref)
        for r in rects:
            col = 0 if r.x0 < 185 else (1 if r.x0 < 370 else 2)
            page_images.append({
                "xref": xref,
                "rect": r,
                "col": col,
                "y0": r.y0,
                "y1": r.y1
            })
            
    # Collect text blocks
    raw_blocks = page.get_text("blocks")
    text_blocks = []
    for b in raw_blocks:
        if b[6] == 0:
            txt = b[4].strip()
            if not txt:
                continue
            if b[1] < 50 and any(cat.lower() in txt.lower() for cat in [
                "frutos secos", "mixes", "cereales", "reposteria", "snacks", "legumbres",
                "condimentos", "azucares", "harinas", "semillas", "suplementos", "aceites",
                "otros", "chocolates", "herboristeria"
            ]):
                continue
            col = 0 if b[0] < 185 else (1 if b[0] < 370 else 2)
            text_blocks.append({
                "bbox": b[:4],
                "text": txt,
                "col": col,
                "x0": b[0],
                "y0": b[1],
                "x1": b[2],
                "y1": b[3]
            })
            
    # Process column by column
    for col_idx in [0, 1, 2]:
        col_blocks = [b for b in text_blocks if b["col"] == col_idx]
        col_blocks.sort(key=lambda b: b["y0"])
        col_images = [img for img in page_images if img["col"] == col_idx]
        col_images.sort(key=lambda img: img["y0"])
        
        idx = 0
        while idx < len(col_blocks):
            b = col_blocks[idx]
            txt = b["text"]
            
            if txt.strip() == "Sin imagen":
                idx += 1
                continue
            
            lines = [l.strip() for l in txt.split("\n") if l.strip()]
            has_price_only = all(re.search(r'x\d+kg|x\d+g|x\d+ml|\$', l, re.I) for l in lines)
            
            if has_price_only:
                idx += 1
                continue
            
            prod_name = lines[0]
            desc_lines = []
            price_lines = []
            
            for line in lines[1:]:
                if re.search(r'x\d+kg|x\d+g|x\d+ml|\$', line, re.I):
                    price_lines.append(line)
                else:
                    desc_lines.append(line)
            
            next_idx = idx + 1
            while next_idx < len(col_blocks):
                nb = col_blocks[next_idx]
                n_lines = [l.strip() for l in nb["text"].split("\n") if l.strip()]
                if nb["text"].strip() == "Sin imagen":
                    next_idx += 1
                    continue
                
                has_price = any(re.search(r'x\d+kg|x\d+g|x\d+ml|\$', l, re.I) for l in n_lines)
                is_pure_price = all(re.search(r'x\d+kg|x\d+g|x\d+ml|\$', l, re.I) for l in n_lines)
                dist = nb["y0"] - b["y1"]
                
                if dist < 65 and (is_pure_price or (has_price and len(n_lines) <= 4)):
                    for line in n_lines:
                        if re.search(r'x\d+kg|x\d+g|x\d+ml|\$', line, re.I):
                            price_lines.append(line)
                        else:
                            desc_lines.append(line)
                    next_idx += 1
                elif dist < 30 and not has_price and len(desc_lines) == 0 and len(price_lines) == 0:
                    desc_lines.extend(n_lines)
                    next_idx += 1
                else:
                    break
            
            idx = next_idx
            
            # Parse price lines into scales
            scales = {}
            current_scale = "x1kg"
            for pline in price_lines:
                parts = re.split(r'\s+', pline)
                for part in parts:
                    if re.match(r'^x\d+(?:kg|g|ml|l)$', part, re.I):
                        current_scale = part.lower()
                    elif '$' in part or re.match(r'^\d+[\.,]\d+$', part):
                        p = parse_price(part)
                        if p > 0:
                            scales[current_scale] = p
            
            matching_img = None
            closest_dist = 999999
            for img in col_images:
                dist = abs(b["y0"] - img["y1"])
                if img["y0"] <= b["y0"] + 15 and dist < 120:
                    if dist < closest_dist:
                        closest_dist = dist
                        matching_img = img
            
            image_url = None
            if matching_img and "Sin imagen" not in txt and page_num < 19:
                xref = matching_img["xref"]
                slug = slugify(prod_name)
                if xref not in saved_images:
                    base_img = doc.extract_image(xref)
                    img_bytes = base_img["image"]
                    ext = base_img["ext"]
                    filename = f"{slug}_{xref}.{ext}"
                    filepath = os.path.join(img_out_dir, filename)
                    with open(filepath, "wb") as f:
                        f.write(img_bytes)
                    saved_images[xref] = f"/catalogo/productos/{filename}"
                image_url = saved_images[xref]
            
            p_base = scales.get("x1kg", 0)
            if not p_base and scales:
                p_base = list(scales.values())[0]
            
            cleaned_name = clean_text(prod_name)
            if len(cleaned_name) < 2 or cleaned_name.lower() in ["sin imagen", "indice"]:
                continue
            
            codigo = f"MP-{len(all_products) + 1:03d}"
            
            all_products.append({
                "id": len(all_products) + 1,
                "codigo": codigo,
                "nombre": cleaned_name,
                "descripcion": clean_text(" ".join(desc_lines)),
                "categoria": category,
                "pagina": page_num,
                "precio_venta": p_base,
                "precio_5kg": scales.get("x5kg", 0),
                "precio_10kg": scales.get("x10kg", 0),
                "precio_25kg": scales.get("x25kg", 0),
                "precio_30kg": scales.get("x30kg", 0),
                "escalas": scales,
                "imagen": image_url,
                "unidad_medida": "kg" if not any(k in ["x360ml", "x500ml", "x250ml", "x1l", "x2lt", "x5lt"] for k in scales) else "unidad"
            })

doc.close()

# Categorias list
categories_summary = []
cats_seen = {}
for p in all_products:
    c = p["categoria"]
    if c not in cats_seen:
        cats_seen[c] = {
            "nombre": c,
            "cantidad_productos": 0,
            "primera_pagina": p["pagina"]
        }
    cats_seen[c]["cantidad_productos"] += 1

categories_summary = list(cats_seen.values())

output_data = {
    "empresa": "Mix Point Mayorista",
    "linea_whatsapp": "1167873243",
    "alias_pago": "mixpoint2026",
    "deposito": "San Isidro 2135 Ituzaingó, Buenos Aires",
    "total_productos": len(all_products),
    "total_paginas_revista": 21,
    "categorias": categories_summary,
    "productos": all_products
}

# Write frontend and backend JSON
frontend_json = os.path.join(frontend_data_dir, "catalogo_completo.json")
backend_json = os.path.join(backend_data_dir, "catalogo_completo.json")

with open(frontend_json, "w", encoding="utf-8") as f:
    json.dump(output_data, f, indent=2, ensure_ascii=False)

with open(backend_json, "w", encoding="utf-8") as f:
    json.dump(output_data, f, indent=2, ensure_ascii=False)

print(f"Generated {frontend_json} and {backend_json}")
print(f"Total products: {len(all_products)}")
print(f"Total categories: {len(categories_summary)}")
