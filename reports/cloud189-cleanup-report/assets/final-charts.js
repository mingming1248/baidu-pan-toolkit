(function () {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();

  // ---- Chart 1: 累计删除进度曲线 ----
  var el1 = document.getElementById('chart-timeline');
  if (el1) {
    var c1 = echarts.init(el1, null, { renderer: 'svg' });
    c1.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis', appendToBody: true,
        formatter: function (ps) {
          var p = ps[0];
          var h = Math.floor(p.value[0]);
          var m = Math.round((p.value[0] - h) * 60);
          return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
            + '<br/>累计删除 ' + p.value[1].toLocaleString('en-US') + ' 个';
        }
      },
      grid: { left: 70, right: 30, top: 40, bottom: 40 },
      xAxis: {
        type: 'value', min: 0, max: 24,
        axisLabel: {
          color: muted,
          formatter: function (v) { return String(v).padStart(2, '0') + ':00'; }
        },
        splitLine: { lineStyle: { color: rule } },
        axisLine: { show: false }, axisTick: { show: false },
        name: '时间（09-09）', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: muted, fontSize: 11 }
      },
      yAxis: {
        type: 'value', max: 120000,
        axisLabel: { color: muted, formatter: function (v) { return v >= 10000 ? (v / 10000) + '万' : v; } },
        splitLine: { lineStyle: { color: rule } }
      },
      series: [
        {
          type: 'line', smooth: 0.25, symbolSize: 7, symbol: 'circle',
          lineStyle: { color: accent, width: 3 },
          itemStyle: { color: accent, borderColor: bg2, borderWidth: 2 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: accent + '4d' },
                { offset: 1, color: accent + '05' }
              ]
            }
          },
          data: [
            [1.4, 0],
            [1.6, 9295],
            [17.2, 9295],
            [17.55, 17162],
            [17.8, 19962],
            [18.67, 36762],
            [22.63, 116686]
          ],
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: muted, type: 'dashed', width: 1 },
            label: { color: muted, fontSize: 11, formatter: '串行重启 17:11' },
            data: [{ xAxis: 17.18 }]
          },
          markPoint: {
            symbol: 'circle', symbolSize: 9,
            itemStyle: { color: accent2 },
            label: { show: true, position: 'left', color: accent2, fontSize: 11, fontWeight: 600, formatter: '完成 100%' },
            data: [{ coord: [22.63, 116686] }]
          }
        }
      ]
    });
    window.addEventListener('resize', function () { c1.resize(); });
  }

  // ---- Chart 2: 全盘空间最终去向 ----
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
            { value: 822.9, name: '保留数据（唯一版本）', itemStyle: { color: muted } },
            { value: 732.0, name: '回收站暂存（本次删除）', itemStyle: { color: accent } },
            { value: 98.3, name: 'B2 类零散重复（待决策）', itemStyle: { color: accent2 } }
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
})();
