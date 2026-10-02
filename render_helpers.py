from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent

def _rgb(value):
    return ImageColor.getrgb(value)[:3]

def _font(path, size):
    return ImageFont.truetype(str(path), max(1, int(round(size))))

def _trim(im):
    im = ImageOps.exif_transpose(im).convert('RGBA')
    box = im.getchannel('A').getbbox()
    return im.crop(box) if box else im

def _glow(im, blur=10, opacity=102):
    im = im.convert('RGBA')
    alpha = im.getchannel('A')
    glow_alpha = alpha.filter(ImageFilter.GaussianBlur(max(1, blur))).point(lambda v: round(v * opacity / 255))
    glow = Image.new('RGBA', im.size, (255,255,255,0)); glow.putalpha(glow_alpha)
    out = Image.new('RGBA', im.size, (0,0,0,0)); out.alpha_composite(glow); out.alpha_composite(im)
    return out

def _place_subject(source, canvas, box, fx, fy, zoom_pct, sx, sy, glow=False):
    src = _trim(source)
    bw, bh = max(1, round(box['width']*sx)), max(1, round(box['height']*sy))
    bx, by = round(box['x']*sx), round(box['y']*sy)
    scale = min(bw/src.width, bh/src.height) * max(.1, float(zoom_pct)/100)
    src = src.resize((max(1,round(src.width*scale)), max(1,round(src.height*scale))), Image.Resampling.LANCZOS)
    if glow: src = _glow(src, max(1,round(69*min(sx,sy))), 77)
    left = bx + round((bw-src.width)*float(fx)); top = by + round((bh-src.height)*float(fy))
    canvas.alpha_composite(src, (left, top))

def _pos(draw, text, font, x, y, anchor='mm', stroke=0):
    box = draw.textbbox((0,0), text, font=font, stroke_width=stroke)
    w,h = box[2]-box[0], box[3]-box[1]
    if anchor == 'ne': return x-w, y-box[1]
    if anchor == 'mm': return x-w/2, y-h/2-box[1]
    if anchor == 'mt': return x-w/2, y-box[1]
    return x, y-box[1]

def _gradient(size, bbox, stops, direction='vertical'):
    layer = Image.new('RGBA', size, (0,0,0,0)); px = layer.load()
    if not bbox or not stops: return layer
    x0,y0,x1,y1 = bbox
    parsed = sorted([(_rgb(s['color']), float(s.get('position',0))/100) for s in stops], key=lambda x:x[1])
    vertical = direction != 'horizontal'
    span = max(1, (y1-y0) if vertical else (x1-x0))
    for y in range(max(0,y0), min(size[1],y1)):
        for x in range(max(0,x0), min(size[0],x1)):
            t = ((y-y0) if vertical else (x-x0))/span
            a,b = parsed[0], parsed[-1]
            for i in range(len(parsed)-1):
                if parsed[i][1] <= t <= parsed[i+1][1]: a,b = parsed[i],parsed[i+1]; break
            den = max(1e-9,b[1]-a[1]); u=max(0,min(1,(t-a[1])/den))
            c=tuple(round(a[0][k]*(1-u)+b[0][k]*u) for k in range(3)); px[x,y]=(*c,255)
    return layer

def _mask_text(size, text, font, pos, stroke=0):
    mask=Image.new('L',size,0); ImageDraw.Draw(mask).text(pos,text,font=font,fill=255,stroke_width=stroke,stroke_fill=255); return mask

def _paint(canvas, mask, color=None, gradient=None, bbox=None, direction='vertical', opacity=255):
    if gradient:
        layer=_gradient(canvas.size,bbox,gradient,direction); alpha=mask.point(lambda v: round(v*opacity/255)); layer.putalpha(alpha)
    else:
        r,g,b=_rgb(color or '#FFFFFF'); layer=Image.new('RGBA',canvas.size,(r,g,b,0)); layer.putalpha(mask.point(lambda v: round(v*opacity/255)))
    canvas.alpha_composite(layer)

def _erode_mask(mask, pixels):
    pixels=max(0,int(pixels))
    if pixels<=0:
        return mask.copy()
    size=max(3,pixels*2+1)
    if size%2==0:
        size+=1
    return mask.filter(ImageFilter.MinFilter(size))

def _name(canvas,text,font,x,y,anchor,profile,fill):
    d=ImageDraw.Draw(canvas); pos=_pos(d,text,font,x,y,anchor)
    outer=int(profile.get('outer_stroke_width',3)); inner=int(profile.get('inner_stroke_width',1))
    stops=profile.get('stops'); direction=profile.get('direction','vertical')

    fill_mask=_mask_text(canvas.size,text,font,pos,0)

    if outer:
        full_mask=_mask_text(canvas.size,text,font,pos,outer)
        outer_mask=ImageChops.subtract(full_mask,fill_mask)
        _paint(canvas,outer_mask,gradient=stops,bbox=full_mask.getbbox(),direction=direction)

    _paint(canvas,fill_mask,color=fill)

    if inner:
        inner_core=_erode_mask(fill_mask,inner)
        inner_edge=ImageChops.subtract(fill_mask,inner_core)
        _paint(
            canvas,
            inner_edge,
            color=profile.get('inner_stroke_color','#000000'),
            opacity=int(profile.get('inner_stroke_opacity',128)),
        )

def _position(canvas,text,font,x,y,anchor,stops,direction,fill):
    d=ImageDraw.Draw(canvas); pos=_pos(d,text,font,x,y,anchor)
    shadow=_mask_text(canvas.size,text,font,(pos[0]+2,pos[1]+2),0).filter(ImageFilter.GaussianBlur(1)); _paint(canvas,shadow,'#000000',opacity=255)
    m=_mask_text(canvas.size,text,font,pos,0); _paint(canvas,m,fill,stops,m.getbbox(),direction)
