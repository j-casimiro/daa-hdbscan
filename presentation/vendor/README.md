# Offline visualization dependency

Plotly.js gl3d distribution **2.35.2**, MIT licensed, downloaded from:

- https://cdn.jsdelivr.net/npm/plotly.js-gl3d-dist-min@2.35.2/plotly-gl3d.min.js
- https://cdn.jsdelivr.net/npm/plotly.js-gl3d-dist-min@2.35.2/LICENSE
- https://cdn.jsdelivr.net/npm/plotly.js@2.35.2/dist/plotly-gl3d.min.js.LICENSE.txt

The generator embeds this bundle and both notices into `results.html`. No CDN or
network connection is used when regenerating or opening the presentation.
This dependency is used only for presentation, not by the custom clustering engine.
