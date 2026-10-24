"""Cached, sequential PHIVOLCS acquisition; >=2 s between request starts."""
import argparse
from collections import defaultdict
import csv
import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from bs4 import BeautifulSoup
import numpy as np

BASE = 'https://earthquake.phivolcs.dost.gov.ph/'
RAW = Path('data/raw')
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August']

class Fetcher:
    def __init__(self):
        self.last = 0.0
        RAW.mkdir(parents=True, exist_ok=True)
        self.manifest_path = RAW / 'manifest.json'
        self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {}

    def get(self, name, url):
        path = RAW / name
        if not path.exists():
            time.sleep(max(0, 2.0 - (time.monotonic() - self.last)))
            self.last = time.monotonic()
            # No automatic retries/concurrency. Fail visibly on HTTP errors.
            subprocess.run(['curl', '--fail', '--compressed', '-L', '--max-time', '60',
                            '--user-agent', 'DAA-student-catalog-audit/1.0', '-o', str(path)+'.part', url], check=True)
            Path(str(path)+'.part').replace(path)
        if name in self.manifest and hashlib.sha256(path.read_bytes()).hexdigest() != self.manifest[name]['sha256']:
            raise ValueError('Cached source hash mismatch: '+name)
        if name not in self.manifest:
            self.manifest[name] = {'url': url, 'recorded_at_utc': datetime.now(timezone.utc).isoformat(),
                                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            self.manifest_path.write_text(json.dumps(self.manifest, indent=2)+'\n')
        return path.read_text(errors='replace')

def parse(html, url):
    records, rejected = [], []
    for tr in BeautifulSoup(html, 'html.parser').find_all('tr'):
        cells = tr.find_all('td', recursive=False)
        if len(cells) != 6 or not cells[0].find('a'):
            continue
        text = [' '.join(c.stripped_strings) for c in cells]
        if not re.search(r'\d{4}\s*-', text[0]):
            continue
        try:
            stamp = datetime.strptime(text[0], '%d %B %Y - %I:%M %p').isoformat() + '+08:00'
            lat, lon, depth, mag = map(float, text[1:5])
            if not np.isfinite([lat, lon, depth, mag]).all() or not (-90 <= lat <= 90 and -180 <= lon <= 180 and depth >= 0):
                raise ValueError('invalid numeric range')
            href = cells[0].find('a')['href'].replace('\\', '/').lstrip('/')
            link = urljoin(url, href)
            # Full bulletin identity: minute keys can collide for distinct distant events.
            identity = link.rsplit('/', 1)[-1].removesuffix('.html')
            records.append(dict(event_id=identity, time_ph=stamp, latitude=lat, longitude=lon,
                                depth_km=depth, magnitude=mag, location=text[5], source_url=link, catalog_url=url))
        except (ValueError, KeyError) as exc:
            rejected.append({'row': text, 'reason': str(exc)})
    return records, rejected

def transform(rows):
    """Spherical hypocentral Cartesian approximation (R=6371.0088 km)."""
    lat = np.radians([r['latitude'] for r in rows])
    lon = np.radians([r['longitude'] for r in rows])
    radius = 6371.0088 - np.array([r['depth_km'] for r in rows])
    x = np.column_stack((radius*np.cos(lat)*np.cos(lon), radius*np.cos(lat)*np.sin(lon), radius*np.sin(lat)))
    # Translation improves numerical conditioning; it does not change distances.
    return np.asarray(x - x.mean(axis=0), dtype=np.float64)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--offline', action='store_true'); args = ap.parse_args()
    fetch = Fetcher(); records = {}; rejected = []; revisions = []; months = []; selected = []
    for month in MONTHS:
        name = f'2026_{month}.html'; url = BASE+f'EQLatest-Monthly/2026/{name}'
        if args.offline and not (RAW/name).exists():
            break
        html = fetch.get(name, url)
        rows, bad = parse(html, url); rejected.extend(bad); months.append(month)
        for row in rows:
            if row['event_id'] in records:
                revisions.append({'previous': records[row['event_id']], 'incoming': row})
                # Only exact same source rows are silently skipped; conflicting revisions stop.
                if records[row['event_id']] != row:
                    raise ValueError('Conflicting event revisions require audit: '+row['event_id'])
            records[row['event_id']] = row
        selected = [r for r in records.values() if 12 <= r['latitude'] <= 20 and 118 <= r['longitude'] <= 124]
        print(month, 'catalog cumulative', len(records), 'bounded subset', len(selected), flush=True)
        if len(selected) >= 1000:
            break
    if len(selected) < 1000:
        raise RuntimeError(f'Only {len(selected)} usable events: need 1000; no records fabricated')
    # Audit collisions without treating nearby locations/times as duplicate identities.
    prefixes = defaultdict(list)
    for row in records.values():
        prefixes[re.sub(r'_B\d+F?$', '', row['event_id'])].append(row)
    collisions = {k: v for k, v in prefixes.items() if len(v) > 1}
    selected.sort(key=lambda r: (r['time_ph'], r['event_id']))
    seed = 2026
    selected = [selected[i] for i in np.random.default_rng(seed).permutation(len(selected))]
    with open('data/events.csv', 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(selected[0])); writer.writeheader(); writer.writerows(selected)
    np.save('data/coordinates.npy', transform(selected))
    audit = dict(year=2026, months=months, bounds=dict(latitude=[12,20],longitude=[118,124]),
                 catalog_unique=len(records), subset_unique=len(selected), seed=seed, rejected=rejected,
                 repeated_ids=revisions, minute_prefix_collisions=collisions,
                 identity_policy='Full bulletin filename; remove only exact repeated rows. Distinct bulletin suffixes retained and prefix collisions audited.',
                 first_time=min(r['time_ph'] for r in selected),
                 last_time=max(r['time_ph'] for r in selected),
                 coordinate_model='sphere R=6371.0088 km minus catalog depth; centered Cartesian',
                 datum='Not specified on inspected catalog summaries; prototype spherical approximation',
                 depth_reference='Not specified on inspected summaries; treated as radial depth below sphere')
    Path('data/audit.json').write_text(json.dumps(audit, indent=2)+'\n')

if __name__ == '__main__':
    main()
