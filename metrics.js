

// Follows remote_write payload format (see https://github.com/prometheus/prometheus/blob/main/prompb/types.proto)
// await pushTimeseries(
//   {
//     labels: {
//       __name__: "queue_depth_total",
//       instance: "dev.example.com",
//       service: "SQS",
//     },
//     samples: [
//       {
//         value: 150,
//         timestamp: Date.now(),
//       },
//     ],
//   },
//   config
// )

// async function pushMetricData (metrics) {
//     console.log('write to prom...')
//     const response = await pushMetrics(metrics, config)
//     console.log(response)
// }

