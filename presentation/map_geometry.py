"""Clip sourced Natural Earth polylines to the display box; never alter event data."""
import json
from pathlib import Path


def clip_segment(a, b, box):
    """Liang–Barsky clipping preserves coastlines without invented border connectors."""
    xmin, xmax, ymin, ymax = box
    x, y = a[:2]
    dx, dy = b[0]-x, b[1]-y
    start, end = 0.0, 1.0
    for p, q in [(-dx,x-xmin),(dx,xmax-x),(-dy,y-ymin),(dy,ymax-y)]:
        if p == 0:
            if q < 0:
                return None
        elif p < 0:
            start = max(start, q/p)
        else:
            end = min(end, q/p)
        if start > end:
            return None
    return [[round(x+start*dx,6),round(y+start*dy,6)],
            [round(x+end*dx,6),round(y+end*dy,6)]]


def build_map(root, bounds):
    folder = Path(root)/'presentation/map'
    box = [*bounds['longitude'],*bounds['latitude']]
    raw = json.loads((folder/'ne_50m_coastline.geojson').read_text())
    segments = []
    for feature in raw['features']:
        geometry = feature['geometry']
        lines = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
        for line in lines:
            run = []
            for a,b in zip(line,line[1:]):
                clipped = clip_segment(a,b,box)
                if clipped:
                    if run and run[-1] == clipped[0]:
                        run.append(clipped[1])
                    else:
                        if len(run)>1:
                            segments.append(run)
                        run=clipped
                elif run:
                    if len(run)>1:
                        segments.append(run)
                    run=[]
            if len(run)>1:
                segments.append(run)
    places = json.loads((folder/'ne_50m_populated_places_simple.geojson').read_text())
    wanted = {'Manila','Baguio','Laoag'}
    labels = []
    for f in places['features']:
        name = f['properties']['name']
        lon,lat = f['geometry']['coordinates'][:2]
        if name in wanted and box[0]<=lon<=box[1] and box[2]<=lat<=box[3]:
            labels.append(dict(name=name,longitude=lon,latitude=lat))
    assert {p['name'] for p in labels} == wanted
    assert segments
    assert all(box[0]<=lon<=box[1] and box[2]<=lat<=box[3]
               for line in segments for lon,lat in line)
    return dict(coastlines=segments,places=labels,bounds=bounds,
                attribution='Made with Natural Earth · 1:50m coastline and populated places · public domain',
                source_url='https://www.naturalearthdata.com/',repository_release='v5.1.2')
