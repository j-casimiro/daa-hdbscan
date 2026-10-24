import csv
import hashlib
import json
from pathlib import Path
import numpy as np
from acquire import parse, transform


def test_real_dataset_provenance_and_coordinates():
    rows=list(csv.DictReader(open('data/events.csv')))
    assert len(rows)==1245
    assert len({r['event_id'] for r in rows})==len(rows)
    assert all(12<=float(r['latitude'])<=20 and 118<=float(r['longitude'])<=124 for r in rows)
    x=np.load('data/coordinates.npy')
    assert x.shape==(len(rows),3) and x.dtype==np.float64 and np.isfinite(x).all()
    numeric=[dict(r,latitude=float(r['latitude']),longitude=float(r['longitude']),depth_km=float(r['depth_km'])) for r in rows]
    np.testing.assert_allclose(x,transform(numeric))
    for name,entry in json.loads(Path('data/raw/manifest.json').read_text()).items():
        assert hashlib.sha256((Path('data/raw')/name).read_bytes()).hexdigest()==entry['sha256']


def test_radial_depth_and_common_kilometer_scale():
    rows=[dict(latitude=0,longitude=0,depth_km=0),dict(latitude=0,longitude=0,depth_km=10),
          dict(latitude=0,longitude=1,depth_km=0)]
    x=transform(rows)
    assert np.isclose(np.linalg.norm(x[0]-x[1]),10)
    assert 111<np.linalg.norm(x[0]-x[2])<112


def test_parser_preserves_different_bulletins_and_reports_bad_numbers():
    def row(suffix,lat):
        return f'<tr><td><a href="../../2026_Earthquake_Information/January/2026_0101_0100_{suffix}.html">01 January 2026 - 09:00 AM</a></td><td>{lat}</td><td>120</td><td>10</td><td>2</td><td>Location</td></tr>'
    rows,bad=parse('<table>'+row('B1','17')+row('B2F','6')+row('B3','nan')+'</table>',
                   'https://earthquake.phivolcs.dost.gov.ph/EQLatest-Monthly/2026/2026_January.html')
    assert len(rows)==2 and len(bad)==1
    assert rows[0]['event_id']!=rows[1]['event_id']
    assert rows[0]['source_url']=='https://earthquake.phivolcs.dost.gov.ph/2026_Earthquake_Information/January/2026_0101_0100_B1.html'
    assert rows[0]['time_ph'].endswith('+08:00')
