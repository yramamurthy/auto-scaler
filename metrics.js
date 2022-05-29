const { pushMetrics, pushTimeseries } = require('prometheus-remote-write')
// const memjs = require('memjs');
// const jpickle = require('jpickle');
const { MongoClient } = require('mongodb')

// var client = memjs.Client.create(process.env.MEMCACHIER_SERVERS, {
//   username: process.env.MEMCACHIER_USERNAME,
//   password: process.env.MEMCACHIER_PASSWORD
// });


// initialize environment variables
const promURI = process.env.PROMETHEUS_ENDPOINT
const userName = process.env.PROMETHEUS_USERNAME
const password = process.env.PROMETHEUS_PASSWORD
const uri = process.env.DATABASE_URL
const mclient = new MongoClient(uri);

const config = {
    // Remote url
    url: promURI,
    // Auth settings
    auth: {
        username: userName,
        password: password,
    },
    // Optional prometheus protocol descripton .proto/.json
    proto: undefined,
    // Logging & debugging, disabled by default
    console: undefined,
    verbose: false,
    timing: false,
    // Override used node-fetch
    fetch: undefined,
    // Additional labels to apply to each timeseries, i.e. [{ service: "SQS" }]
    labels: undefined
};

const pushmetrics = async (metrics) => {
    try {
        // Connect to the MongoDB cluster
        let db = await mclient.connect()
        let dbo = db.db('algo_cache')

        // fetch the metrics
        stats = await dbo.collection("replica").find({"key": "metrics"}).toArray()

        if (stats) {
            data=JSON.parse(stats[0].value)
            for (key in data) {
                if (key!='t')
                    metrics[key]=data[key]
            }
            
        }
        if (Object.keys(metrics).length) {
            pushMetrics(metrics, config)
        } else {
            // console.log('nothing')
        }
        await mclient.close()
    } catch (e) {
        console.error(e)
    }

}

module.exports = {
    pushmetrics,
};

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

