package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handlePlayground(w http.ResponseWriter, r *http.Request) {
	// Get chains from store
	chains := s.store.GetChains()

	// Get metrics from registered metrics
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
  <title>Metrics Playground</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>[x-cloak] { display: none !important; }</style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen p-4">
  <div x-data="playground()" x-init="init()" class="max-w-4xl mx-auto">
    <h1 class="text-2xl font-bold mb-6 text-cyan-400">Metrics Playground</h1>
    
    <!-- Mode toggle -->
    <div class="flex gap-2 mb-4">
      <button @click="mode = 'metrics'; fetch()" 
              :class="mode === 'metrics' ? 'bg-cyan-600' : 'bg-gray-700'" 
              class="px-4 py-2 rounded text-sm font-medium">
        Time Series
      </button>
      <button @click="mode = 'rolling'; fetch()" 
              :class="mode === 'rolling' ? 'bg-cyan-600' : 'bg-gray-700'"
              class="px-4 py-2 rounded text-sm font-medium">
        Rolling Window
      </button>
    </div>

    <!-- Controls -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div>
        <label class="block text-xs text-gray-400 mb-1">Chain</label>
        <select x-model="chainId" @change="fetch()" class="w-full bg-gray-800 rounded px-3 py-2 text-sm">
          <template x-for="c in chains" :key="c">
            <option :value="c" x-text="c"></option>
          </template>
          <option value="total">Total</option>
        </select>
      </div>
      
      <div>
        <label class="block text-xs text-gray-400 mb-1">Metric</label>
        <select x-model="metric" @change="fetch()" class="w-full bg-gray-800 rounded px-3 py-2 text-sm">
          <template x-for="m in metrics" :key="m">
            <option :value="m" x-text="m"></option>
          </template>
        </select>
      </div>
      
      <template x-if="mode === 'metrics'">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Granularity</label>
          <select x-model="granularity" @change="prefillDates(); fetch()" class="w-full bg-gray-800 rounded px-3 py-2 text-sm">
            <option value="hour">Hour</option>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      </template>
      
      <div>
        <label class="block text-xs text-gray-400 mb-1">&nbsp;</label>
        <button @click="fetch()" :disabled="loading"
                class="w-full bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-600 rounded px-4 py-2 text-sm font-medium">
          <span x-show="!loading">Fetch</span>
          <span x-show="loading">...</span>
        </button>
      </div>
    </div>

    <!-- Date range (only for time series) -->
    <template x-if="mode === 'metrics'">
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Start</label>
          <input type="datetime-local" x-model="startDate" @change="fetch()"
                 class="w-full bg-gray-800 rounded px-3 py-2 text-sm">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">End</label>
          <input type="datetime-local" x-model="endDate" @change="fetch()"
                 class="w-full bg-gray-800 rounded px-3 py-2 text-sm">
        </div>
      </div>
    </template>

    <!-- Error -->
    <div x-show="error" x-cloak class="bg-red-900/50 text-red-300 rounded p-3 mb-4 text-sm" x-text="error"></div>

    <!-- API Request -->
    <div x-show="lastUrl" x-cloak class="bg-gray-800 rounded p-3 mb-4">
      <div class="text-xs text-gray-400 mb-1">API Request</div>
      <a :href="lastUrl" target="_blank" class="text-xs text-cyan-300 hover:text-cyan-200 underline break-all" x-text="location.origin + lastUrl"></a>
    </div>

    <!-- Chart -->
    <div x-show="mode === 'metrics' && chartData.length > 0" x-cloak class="bg-gray-800 rounded p-4 mb-4">
      <canvas id="chart" height="200"></canvas>
    </div>

    <!-- Rolling window results -->
    <div x-show="mode === 'rolling' && rollingData" x-cloak class="bg-gray-800 rounded p-4">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <template x-for="[key, val] in Object.entries(rollingData || {})" :key="key">
          <div class="text-center">
            <div class="text-xs text-gray-400 mb-1" x-text="formatKey(key)"></div>
            <div class="text-lg font-mono text-cyan-400" x-text="formatValue(val)"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Raw JSON -->
    <details class="mt-4">
      <summary class="text-xs text-gray-500 cursor-pointer">Raw Response</summary>
      <pre class="bg-gray-800 rounded p-3 mt-2 text-xs overflow-auto max-h-64" x-text="JSON.stringify(rawResponse, null, 2)"></pre>
    </details>
  </div>

  <script>
    const CHAINS = ` + string(chainsJSON) + `;
    const METRICS = ` + string(metricsJSON) + `;

    function playground() {
      return {
        mode: 'metrics',
        chainId: '43114',
        metric: 'icmGasBurned',
        granularity: 'month',
        startDate: '',
        endDate: '',
        chains: CHAINS.map(String),
        metrics: METRICS,
        loading: false,
        error: '',
        chartData: [],
        rollingData: null,
        rawResponse: null,
        lastUrl: '',
        chart: null,

        init() {
          this.prefillDates();
          this.fetch();
        },

        prefillDates() {
          const now = new Date();
          const end = new Date(now);
          end.setMinutes(0, 0, 0);
          
          let start = new Date(end);
          switch (this.granularity) {
            case 'hour': start.setHours(start.getHours() - 48); break;
            case 'day': start.setDate(start.getDate() - 30); break;
            case 'week': start.setDate(start.getDate() - 84); break;
            case 'month': start.setMonth(start.getMonth() - 12); break;
          }
          
          this.startDate = this.toLocalISO(start);
          this.endDate = this.toLocalISO(end);
        },

        toLocalISO(d) {
          return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        },

        async fetch() {
          this.loading = true;
          this.error = '';
          this.rawResponse = null;
          
          try {
            if (this.mode === 'metrics') {
              await this.fetchTimeSeries();
            } else {
              await this.fetchRolling();
            }
          } catch (e) {
            this.error = e.message;
          }
          
          this.loading = false;
        },

        async fetchTimeSeries() {
          const startTs = Math.floor(new Date(this.startDate).getTime() / 1000);
          const endTs = Math.floor(new Date(this.endDate).getTime() / 1000);
          
          const url = '/v2/chains/' + this.chainId + '/metrics/' + this.metric + 
            '?startTimestamp=' + startTs + '&endTimestamp=' + endTs + 
            '&timeInterval=' + this.granularity + '&pageSize=500';
          
          this.lastUrl = url;
          const res = await window.fetch(url);
          if (!res.ok) throw new Error(await res.text());
          
          const data = await res.json();
          this.rawResponse = data;
          this.chartData = (data.results || []).reverse();
          this.renderChart();
        },

        async fetchRolling() {
          const url = '/v2/chains/' + this.chainId + '/rollingWindowMetrics/' + this.metric;
          this.lastUrl = url;
          const res = await window.fetch(url);
          if (!res.ok) throw new Error(await res.text());
          
          const data = await res.json();
          this.rawResponse = data;
          this.rollingData = data.result;
        },

        renderChart() {
          this.$nextTick(() => {
            const ctx = document.getElementById('chart');
            if (!ctx) return;
            
            if (this.chart) this.chart.destroy();
          
          this.chart = new Chart(ctx, {
            type: 'bar',
            data: {
              labels: this.chartData.map(d => {
                const date = new Date(d.timestamp * 1000);
                if (this.granularity === 'hour') return date.toLocaleString('en', {month:'short', day:'numeric', hour:'numeric'});
                return date.toLocaleDateString('en', {month:'short', day:'numeric'});
              }),
              datasets: [{
                data: this.chartData.map(d => parseFloat(d.value) || 0),
                backgroundColor: 'rgba(34, 211, 238, 0.6)',
                borderColor: 'rgba(34, 211, 238, 1)',
                borderWidth: 1
              }]
            },
            options: {
              responsive: true,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: '#9ca3af', maxTicksLimit: 10 }, grid: { color: '#374151' } },
                y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } }
              }
            }
          });
          });
        },

        formatKey(k) {
          return k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        },

        formatValue(v) {
          if (!v || v === '0') return '0';
          const n = parseFloat(v);
          if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
          if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
          if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
          if (n >= 1e3) return (n/1e3).toFixed(2) + 'K';
          return n.toLocaleString();
        },

        curlCmd() {
          return 'curl "' + location.origin + this.lastUrl + '"';
        }
      };
    }
  </script>
</body>
</html>`
}
