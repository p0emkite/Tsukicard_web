from render_helpers import *

def render_card(photo_path, name, template, element_color='#FFFFFF', text_color='#FFFFFF', focus_x=.5, focus_y=.5, zoom=1.0, font_override=None, out_size=None, extra=None):
    extra=extra or {}; native=template['native_canvas']; out_size=out_size or (native['width'],native['height'])
    w,h=map(int,out_size); sx,sy=w/native['width'],h/native['height']
    canvas=Image.new('RGBA',(w,h),(0,0,0,0))
    with Image.open(ROOT/template['background']) as im: canvas.alpha_composite(im.convert('RGBA').resize((w,h),Image.Resampling.LANCZOS))
    with Image.open(photo_path) as im: _place_subject(im,canvas,template['subject_box'],focus_x,focus_y,zoom*100 if zoom<=3 else zoom,sx,sy,bool(extra.get('subject_glow')))
    with Image.open(ROOT/template['overlay']) as im: canvas.alpha_composite(im.convert('RGBA').resize((w,h),Image.Resampling.LANCZOS))
    team=extra.get('team_name','')
    if team and team in template.get('team_logos',{}):
        with Image.open(ROOT/template['team_logos'][team]) as im: logo=im.convert('RGBA').resize((w,h),Image.Resampling.LANCZOS)
        canvas.alpha_composite(_glow(logo,max(1,round(10*min(sx,sy))),102))
    hc,nc,pc=template['top_right_text'],template['name_text'],template['position_text']
    header=str(extra.get('top_right_text','')).strip()
    if header:
        f=_font(Path(extra['header_font_path']),float(extra.get('top_right_size',hc.get('font_size',28)))*sy); d=ImageDraw.Draw(canvas)
        p=_pos(d,header,f,float(extra.get('top_right_x',hc['x']))*sx,float(extra.get('top_right_y',hc['y']))*sy,hc.get('anchor','ne'))
        d.text(p,header,font=f,fill=extra.get('top_right_color',hc.get('color','#00B03A')))
    gp=extra.get('gradient_profile') or template.get('gradient_profile') or {}; stops=gp.get('stops'); direction=gp.get('direction','vertical')
    nt=str(extra.get('name_text',name or '')).strip()
    if nt:
        f=_font(Path(extra['name_font_path']),float(extra.get('name_size',nc.get('font_size',48)))*sy)
        ne=gp.get('name',{}); prof={'outer_stroke_width':round(float(extra.get('name_outline_width',ne.get('outer_stroke_default',3)))*sy),'inner_stroke_width':round(float(ne.get('inner_stroke_width',1))*sy),'inner_stroke_color':ne.get('inner_stroke_color','#000'),'inner_stroke_opacity':ne.get('inner_stroke_opacity',128),'stops':stops,'direction':direction}
        _name(canvas,nt,f,float(extra.get('name_x',nc['x']))*sx,float(extra.get('name_y',nc['y']))*sy,nc.get('anchor','mm'),prof,extra.get('name_color',nc.get('color',text_color)))
    pt=str(extra.get('position_text','')).strip()
    if pt:
        f=_font(Path(extra['position_font_path']),float(extra.get('position_size',pc.get('font_size',60)))*sy)
        _position(canvas,pt,f,float(extra.get('position_x',pc['x']))*sx,float(extra.get('position_y',pc['y']))*sy,pc.get('anchor','mm'),stops,direction,extra.get('position_color',pc.get('color',text_color)))
    return canvas
