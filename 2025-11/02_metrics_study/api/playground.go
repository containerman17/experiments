package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handlePlayground(w http.ResponseWriter, r *http.Request) {
	chains := s.store.GetChains()

	metrics := make([]string, 0, len(s.metrics)+4)
	for _, m := range s.metrics {
		metrics = append(metrics, m.Name)
	}
	metrics = append(metrics, "cumulativeTxCount", "cumulativeContracts", "cumulativeAddresses", "cumulativeDeployers")

	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(playgroundHTML(chains, metrics)))
}

func playgroundHTML(chains []uint32, metrics []string) string {
	chainsJSON, _ := json.Marshal(chains)
	metricsJSON, _ := json.Marshal(metrics)

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EVM Metrics</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f8f9fa; color: #333; padding: 16px; }
    .header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    h1 { font-size: 20px; font-weight: 600; }
    select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; background: #fff; }
    .periods { display: flex; gap: 4px; }
    .periods button { padding: 6px 12px; border: 1px solid #ddd; background: #fff; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .periods button.active { background: #4285f4; color: #fff; border-color: #4285f4; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 12px; }
    .card { background: #fff; border-radius: 6px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card-title { font-size: 13px; font-weight: 500; margin-bottom: 8px; }
    .chart-wrap { height: 80px; position: relative; }
    .chart-wrap svg { width: 100%; height: 100%; }
    .chart-wrap .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #999; font-size: 12px; }
    .card-footer { margin-top: 6px; font-size: 11px; }
    .card-footer a { color: #4285f4; text-decoration: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-footer a:hover { text-decoration: underline; }
    .tooltip { position: fixed; background: #333; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none; z-index: 100; display: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1>EVM Metrics</h1>
    <div>
      <label>Chain: </label>
      <select id="chainSelect"></select>
    </div>
    <div>
      <label>Period: </label>
      <span class="periods">
        <button data-period="24h">24h</button>
        <button data-period="7d" class="active">7d</button>
        <button data-period="30d">30d</button>
        <button data-period="90d">90d</button>
        <button data-period="180d">180d</button>
        <button data-period="1y">1y</button>
        <button data-period="3y">3y</button>
      </span>
    </div>
  </div>
  <div class="grid" id="grid"></div>
  <div class="tooltip" id="tooltip"></div>

  <script>
    const CHAINS = ` + string(chainsJSON) + `;
    const METRICS = ` + string(metricsJSON) + `;
    const CHAIN_NAMES = {43114: 'C-Chain', 73772: 'Swimmer', 432204: 'Dexalot', 4337: 'Beam'};
    const PERIODS = {
      '24h':  { hours: 24,       granularity: 'hour' },
      '7d':   { hours: 24*7,     granularity: 'hour' },
      '30d':  { hours: 24*30,    granularity: 'day' },
      '90d':  { hours: 24*90,    granularity: 'day' },
      '180d': { hours: 24*180,   granularity: 'week' },
      '1y':   { hours: 24*365,   granularity: 'week' },
      '3y':   { hours: 24*365*3, granularity: 'month' }
    };

    let currentChain = '43114';
    let currentPeriod = '7d';
    let abortControllers = {};

    const chainSelect = document.getElementById('chainSelect');
    const grid = document.getElementById('grid');
    const tooltip = document.getElementById('tooltip');

    // Init chain selector
    CHAINS.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = CHAIN_NAMES[c] ? CHAIN_NAMES[c] + ' (ID: ' + c + ')' : 'Chain ' + c;
      chainSelect.appendChild(opt);
    });
    const totalOpt = document.createElement('option');
    totalOpt.value = 'total';
    totalOpt.textContent = 'All Chains (Total)';
    chainSelect.appendChild(totalOpt);
    chainSelect.value = currentChain;

    chainSelect.onchange = () => { currentChain = chainSelect.value; fetchAll(); };

    // Period buttons
    document.querySelectorAll('.periods button').forEach(btn => {
      btn.onclick = () => {
        document.querySelector('.periods button.active').classList.remove('active');
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        fetchAll();
      };
    });

    // Create cards
    METRICS.forEach(m => {
      const card = document.createElement('div');
      card.className = 'card';
      card.id = 'card-' + m;
      card.innerHTML = '<div class="card-title">' + formatMetricName(m) + '</div>' +
        '<div class="chart-wrap"><div class="loading">Loading...</div><svg viewBox="0 0 400 80" preserveAspectRatio="none"></svg></div>' +
        '<div class="card-footer"><a class="data-link" target="_blank">JSON</a></div>';
      grid.appendChild(card);
    });

    function formatMetricName(m) {
      return m.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
    }

    function fetchAll() {
      METRICS.forEach(m => fetchMetric(m));
    }

    async function fetchMetric(metric) {
      const card = document.getElementById('card-' + metric);
      const svg = card.querySelector('svg');
      const loading = card.querySelector('.loading');
      const dataLink = card.querySelector('.data-link');

      // Abort previous
      if (abortControllers[metric]) abortControllers[metric].abort();
      abortControllers[metric] = new AbortController();
      const signal = abortControllers[metric].signal;

      loading.style.display = 'flex';
      svg.innerHTML = '';

      const p = PERIODS[currentPeriod];
      const now = Math.floor(Date.now() / 1000);
      const startTs = now - p.hours * 3600;
      
      // Cumulative metrics don't support hour granularity
      let granularity = p.granularity;
      if (metric.startsWith('cumulative') && granularity === 'hour') {
        granularity = 'day';
      }

      const url = '/v2/chains/' + currentChain + '/metrics/' + metric +
        '?startTimestamp=' + startTs + '&endTimestamp=' + now +
        '&timeInterval=' + granularity + '&pageSize=500';

      dataLink.href = url;
      dataLink.textContent = url;

      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        if (signal.aborted) return;

        const points = (data.results || []).reverse();
        if (points.length > 0) {
          renderChart(svg, points, metric);
        } else {
          svg.innerHTML = '<text x="200" y="45" text-anchor="middle" fill="#999" font-size="12">No data</text>';
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        svg.innerHTML = '<text x="200" y="45" text-anchor="middle" fill="#c00" font-size="12">Error</text>';
      } finally {
        if (!signal.aborted) loading.style.display = 'none';
      }
    }

    function renderChart(svg, points, metric) {
      const vals = points.map(p => parseFloat(p.value) || 0);
      const times = points.map(p => p.timestamp);
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const range = max - min || 1;

      const w = 400, h = 80, padY = 4;
      const scaleX = i => (i / (vals.length - 1)) * w;
      const scaleY = v => padY + (1 - (v - min) / range) * (h - padY * 2);

      // Line path
      let d = vals.map((v, i) => (i === 0 ? 'M' : 'L') + scaleX(i).toFixed(1) + ',' + scaleY(v).toFixed(1)).join(' ');
      
      // Fill path
      let fillD = d + ' L' + w + ',' + h + ' L0,' + h + ' Z';

      svg.innerHTML = 
        '<defs><linearGradient id="grad-' + metric + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#4285f4" stop-opacity="0.3"/>' +
        '<stop offset="100%" stop-color="#4285f4" stop-opacity="0.05"/>' +
        '</linearGradient></defs>' +
        '<path d="' + fillD + '" fill="url(#grad-' + metric + ')"/>' +
        '<path d="' + d + '" fill="none" stroke="#4285f4" stroke-width="1.5"/>' +
        '<circle class="hover-dot" r="4" fill="#4285f4" stroke="#fff" stroke-width="1.5" style="display:none"/>' +
        '<rect class="hover-area" x="0" y="0" width="' + w + '" height="' + h + '" fill="transparent"/>';

      // Hover interaction
      const hoverArea = svg.querySelector('.hover-area');
      const hoverDot = svg.querySelector('.hover-dot');
      hoverArea.onmousemove = e => {
        const rect = svg.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * w;
        const i = Math.round(x / w * (vals.length - 1));
        if (i >= 0 && i < vals.length) {
          const date = new Date(times[i] * 1000);
          const dateStr = date.toLocaleString('en', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
          tooltip.style.display = 'block';
          tooltip.style.left = e.clientX + 10 + 'px';
          tooltip.style.top = e.clientY - 30 + 'px';
          tooltip.innerHTML = '<b>' + formatValue(vals[i]) + '</b><br>' + dateStr;
          hoverDot.setAttribute('cx', scaleX(i));
          hoverDot.setAttribute('cy', scaleY(vals[i]));
          hoverDot.style.display = 'block';
        }
      };
      hoverArea.onmouseleave = () => { tooltip.style.display = 'none'; hoverDot.style.display = 'none'; };
    }

    function formatValue(v) {
      if (v >= 1e12) return (v/1e12).toFixed(2) + 'T';
      if (v >= 1e9) return (v/1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v/1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v/1e3).toFixed(2) + 'K';
      return v.toLocaleString();
    }

    // Initial fetch
    fetchAll();
  </script>
</body>
</html>`
}
