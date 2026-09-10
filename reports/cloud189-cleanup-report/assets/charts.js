(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // ---- Chart 1: 四类重复文件规模对比 ----
  var el1 = document.getElementById('chart-class');
  if (el1) {
    var c1 = echarts.init(el1, null, { renderer: 'svg' });
    c1.setOption({
      animation: false,
      tooltip: { trigger: 'axis', appendToBody: true },
      legend: { data: ['文件数（个）', '容量（GB）'], top: 0, textStyle: { color: muted, fontSize: 12 } },
      grid: { left: 70, right: 70, top: 44, bottom: 36 },
      xAxis: {
        type: 'category',
        data: ['A类\n同文件夹副本', 'B1类\n整树镜像', 'B2类\n零散重复', 'C类\n时间戳文件夹'],
        axisLabel: { color: ink, fontSize: 12, interval: 0 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      yAxis: [
        {
          type: 'value', name: '文件数（个）', nameTextStyle: { color: muted, fontSize: 11 },
          axisLabel: { color: muted, formatter: function (v) { return v >= 10000 ? (v / 10000) + '万' : v; } },
          splitLine: { lineStyle: { color: rule } }
        },
        {
          type: 'value', name: '容量（GB）', nameTextStyle: { color: muted, fontSize: 11 },
          axisLabel: { color: muted }, splitLine: { show: false }
        }
      ],
      series: [
        {
          name: '文件数（个）', type: 'bar', barWidth: '32%',
          data: [69860, 45529, 17436, 1297],
          itemStyle: { color: accent, borderRadius: [4, 4, 0, 0] },
          label: { show: true, position: 'top', color: ink, fontSize: 11, fontFamily: 'JetBrainsMono, monospace',
            formatter: function (p) { return p.value >= 10000 ? (p.value / 10000).toFixed(1) + '万' : p.value.toLocaleString(); } }
        },
        {
          name: '容量（GB）', type: 'bar', yAxisIndex: 1, barWidth: '32%',
          data: [412.71, 310.60, 98.32, 8.71],
          itemStyle: { color: accent2, borderRadius: [4, 4, 0, 0] },
          label: { show: true, position: 'top', color: ink, fontSize: 11, fontFamily: 'JetBrainsMono, monospace' }
        }
      ]
    });
    window.addEventListener('resize', function () { c1.resize(); });
  }

  // ---- Chart 2: 全盘空间构成（环形图）----
  var el2 = document.getElementById('chart-composition');
  if (el2) {
    var c2 = echarts.init(el2, null, { renderer: 'svg' });
    c2.setOption({
      animation: false,
      tooltip: { trigger: 'item', appendToBody: true, formatter: '{b}<br/>{c} GB（{d}%）' },
      legend: { bottom: 0, textStyle: { color: muted, fontSize: 12 }, itemWidth: 14, itemHeight: 14 },
      series: [
        {
          type: 'pie', radius: ['44%', '68%'], center: ['50%', '46%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: bg2, borderWidth: 2 },
          label: { color: ink, fontSize: 12, formatter: '{b}\n{c} GB' },
          labelLine: { lineStyle: { color: rule } },
          data: [
            { value: 822.9, name: '唯一数据（保留）', itemStyle: { color: muted } },
            { value: 732.0, name: '方案一可释放（删除中）', itemStyle: { color: accent } },
            { value: 98.3, name: 'B2 类待定', itemStyle: { color: accent2 } }
          ]
        }
      ],
      graphic: [{
        type: 'text', left: 'center', top: '42%',
        style: { text: '1,653GB\n全盘总量', textAlign: 'center', fill: ink, fontSize: 17, fontWeight: 700, fontFamily: 'JetBrainsMono, monospace', lineHeight: 24 }
      }]
    });
    window.addEventListener('resize', function () { c2.resize(); });
  }

  // ---- Chart 3: 方案一执行进度（百分比归一化水平堆叠条）----
  var el3 = document.getElementById('chart-progress');
  if (el3) {
    var c3 = echarts.init(el3, null, { renderer: 'svg' });
    c3.setOption({
      animation: false,
      tooltip: { trigger: 'item', appendToBody: true, formatter: function (p) {
        var row = p.dataIndex === 0 ? ['158.6 GB', '573.4 GB'] : ['17,162 个', '99,524 个'];
        var idx = p.seriesName === '已完成' ? 0 : 1;
        return p.name + ' · ' + p.seriesName + '：' + row[idx] + '（' + p.value.toFixed(1) + '%）';
      } },
      legend: { data: ['已完成', '剩余'], top: 0, textStyle: { color: muted, fontSize: 12 } },
      grid: { left: 96, right: 40, top: 40, bottom: 30 },
      xAxis: { type: 'value', max: 100, axisLabel: { show: false }, splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: {
        type: 'category', data: ['按容量（GB）', '按数量（个）'],
        axisLabel: { color: ink, fontSize: 12 }, axisTick: { show: false }, axisLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          name: '已完成', type: 'bar', stack: 'p', barWidth: 34,
          data: [21.7, 14.7],
          itemStyle: { color: accent2, borderRadius: [6, 0, 0, 6] },
          label: { show: true, position: 'inside', color: '#ffffff', fontSize: 12, fontFamily: 'JetBrainsMono, monospace',
            formatter: function (p) { return p.dataIndex === 0 ? '158.6GB · 21.7%' : '17,162个 · 14.7%'; } }
        },
        {
          name: '剩余', type: 'bar', stack: 'p', barWidth: 34,
          data: [78.3, 85.3],
          itemStyle: { color: '#d9e2f2', borderRadius: [0, 6, 6, 0] },
          label: { show: true, position: 'inside', color: muted, fontSize: 12, fontFamily: 'JetBrainsMono, monospace',
            formatter: function (p) { return p.dataIndex === 0 ? '573.4GB' : '99,524个'; } }
        }
      ]
    });
    window.addEventListener('resize', function () { c3.resize(); });
  }

  // ---- Mermaid 初始化 ----
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
  }
})();
