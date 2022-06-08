require('dotenv').config()

const { MongoClient } = require('mongodb')
const Heroku = require('heroku-client')
const schedule = require('node-schedule')
const express = require('express')
const moment = require('moment')
const axios = require('axios').default;
const {createApiClient} = require('dots-wrapper');
const {pushmetrics} = require('./metrics')

const uri = process.env.DATABASE_URL
const dbName = process.env.DATABASE_NAME
const port = process.env.PORT || 3000


// health check endpoint
const app = express()
app.get('/health', function (req, res) {
    res.json({ health: 'OK' })
})

// global variables and constants
let appPlans = []
let formations = []

const dayOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
let fetchingConfig = false

async function getConfig(fireDate) {
    fetchingConfig = true

    const client = new MongoClient(uri);
    const weekDay = dayOfWeek[fireDate.getDay()]
    const year = fireDate.getFullYear()
    const date = moment(fireDate).local().format('YYYY-MM-DD') // fireDate.toISOString().slice(0, 10)
    console.log(`fireDate = ${fireDate}, date=${date}`)

    appPlans = []
    formations = []

    try {
        // Connect to the MongoDB cluster
        let db = await client.connect()
        let dbo = db.db(dbName)

        // fetch the configurations
        plans = await dbo.collection("plans").find({}).toArray()
        plans.sort((a, b) => a.time > b.time)
        formations = await dbo.collection("formations").find({}).toArray()
        appPlans = await dbo.collection("app_plans").find({ enabled: true }).toArray()
        holidays = await dbo.collection("market_holidays").find({ year }).toArray()
        holidaysForYear = holidays.find(item => item.year == year)

        if (holidaysForYear.holidays.includes(date))
            console.log(`Public holiday today(${date})`)
        else
            console.log(`Not a public holiday today(${date})`)

        // frame the flight schedules based on the configuraton
        appPlans.forEach(appPlan => {
            appPlan.plannedFormation = Array.from({ length: 24 * 60 }, (_, i) => appPlan.default_formation)
            appPlan.plans.forEach(plan => {
                planDetail = plans.find(item => item.id == plan && item.days.includes(weekDay) && !holidaysForYear.holidays.includes(date))
                if (planDetail) {
                    splitTime = planDetail.time.split(":")
                    index = parseInt(splitTime[0]) * 60 + parseInt(splitTime[1])
                    for (var i = index; i < 24 * 60; i++) appPlan.plannedFormation[i] = planDetail.formation
                }
            })
        })
        // console.log(`formations - ${JSON.stringify(formations)}\nplans - ${JSON.stringify(plans)}\nappPlans - ${JSON.stringify(appPlans)}\nholidays for ${year} - ${holidaysForYear.holidays}`)
    } catch (e) {
        console.error(e)
    } finally {
        await client.close()
    }
    fetchingConfig = false
}

// Heroku APIs
async function getFormation(platform, appName) {
    const formations = await platform.get(`/apps/${appName}/formation`)
    const formation = formations.find(item=>item.type=='web')
    // console.log(formation)
    return formation
}

async function setFormation(platform, appName, formation) {
    return await platform.patch(`/apps/${appName}/formation`, {
        body: {
            updates: [
                {
                    "type": formation.type,
                    "quantity": formation.quantity,
                    "size": formation.size
                }
            ]
        }
    })
}

async function restartDyno(platform, appName) {
    return await platform.delete(`/apps/${appName}/dynos`, {
        body: {
        }
    })
}

// Digital Ocean APIs
async function getAppId(platform, appName) {
    let appId=null
    const {data:{apps}} = await platform.app.listApps({})
    if (apps) {
        const app = apps.find(item => item.spec.name == appName)
        if (app) {
            appId=app.id
        }
    }
    return appId
}

async function createApp(platform, appName, appSpec) {
    console.log(`creating app ${appName} in digitalocean...`)
    const {data:{app}} = await platform.app.createApp(appSpec);
    return app
}

async function deleteApp(platform, appName) {
    console.log(`deleting app ${appName} in digitalocean...`)
    const appId=await getAppId(platform, appName)
    if (appId == null) {
        console.log(`${appName} doesn't exist!`)
        return
    }
    const input = {
        app_id: appId
      };
    const {status} = await platform.app.deleteApp(input);
    return status
}

async function getRunningAppDeployments(platform, appId) {
    const input = {
        app_id: appId
      };
    const {data:{deployments}} = await platform.app.listAppDeployments(input);
    const runningDeployments = deployments.filter(item=>item.phase != 'ACTIVE' && item.phase != 'CANCELED' && item.phase != 'SUPERSEDED')
    return runningDeployments.length

}

async function updateApp(platform, appName, appSpec) {
    let input = appSpec;
    let app = null;
    input.app_id = await getAppId(platform, appName);
    input.spec.services[0].envs.push({
        "key": "DUMMY",
        "value": `${Math.random()}`,
        "type": "GENERAL"
    })
    
    if (input.app_id == null) {
        console.log(`${appName} doesn't exist!`)
        return
    }
    const runningDeployments = await getRunningAppDeployments(platform, input.app_id)
    if (runningDeployments == 0) {
        console.log(`updateApp ${appName} at digitalocean...`)
        data = await platform.app.updateApp(input);
        if (data)
            app = data.app
    } else {
        console.log(`updateApp ${appName} at digitalocean already in progress...`)
    }
    return app
}

// Common Restart function
async function autoRestart(platformName, platform, appName, appDomain, apiKey, appSpec) {
    url = `${appDomain}restart`
    let response;
    let metricsData = {};
    try{
        response = await axios.get(url, {headers: {'X-API-KEY': apiKey }});
        // console.log(`Got response from ${appName} restart service : ${JSON.stringify(response.data)}`)
        const field=`${appName}_restart_flag`.replace("-","_")
        metricsData = {[field]: response.data.flag?1:0}
        if (response.data.flag) {
            console.log(`restart flag detected for ${appName} - ${response.data.flag}. Restarting...`)
            if (platformName == 'heroku') {
                restartDyno(platform, appName)
            }
            if (platformName == 'dots') {
                updateApp(platform, appName, appSpec)
            }
        }
    } catch (error) {
        // console.error(error);
    }
    return metricsData;
}

const isMarketOpen = (index) => {
    let marketOpen = false;
    // 9:15 => 555
    // 3:30 => 930
    if (index >= 555 && index <= 930) 
        marketOpen = true
    return marketOpen
}

async function autoScale(fireDate) {
    if (fetchingConfig) {
        console.log('Confguration is getting updated. Skipping the autoscale process...')
        return
    }
    var minutes = fireDate.getMinutes()
    var hour = fireDate.getHours()
    var index = hour * 60 + minutes

    data = {}
    // loop through the applications configured to auto scale
    for (let appPlan in appPlans) {
        // console.log(`platform ${appPlans[appPlan].platform.name} for the app ${appPlans[appPlan].app_name} token ${appPlans[appPlan].platform.token}`)
        try {
            // check for platform 
            if (appPlans[appPlan].platform === undefined || appPlans[appPlan].platform.name === undefined) {
                console.log(`undefined platform ${appPlans[appPlan].platform.name} for the app ${appPlans[appPlan].app_name}`)
                continue
            }
            // is the platform known ?
            if (!appPlans[appPlan].platform.name in ['heroku']) {
                console.log(`unknown platform ${appPlans[appPlan].platform.name} for the app ${appPlans[appPlan].app_name}`)
                continue
            }
            if (appPlans[appPlan].platform.name === 'heroku' && !appPlans[appPlan].platform.instance) {
                appPlans[appPlan].platform.instance = new Heroku({ token: appPlans[appPlan].platform.token })
            }

            if (appPlans[appPlan].platform.name === 'dots' && !appPlans[appPlan].platform.instance) {
                appPlans[appPlan].platform.instance = createApiClient({token: appPlans[appPlan].platform.token});
            }

            if (appPlans[appPlan].platform.name === 'heroku') {
                // fetch the current formation for the configured application
                let currentFormation = await getFormation(appPlans[appPlan].platform.instance, appPlans[appPlan].app_name)

                // fetch the planned formation for the current minute
                let plannedFormation = formations.find(item => item.id == appPlans[appPlan].plannedFormation[index])

                // check if the planned formation differ from the current formation
                if (plannedFormation.type != currentFormation.type ||
                    plannedFormation.size != currentFormation.size ||
                    plannedFormation.quantity != currentFormation.quantity) {
                    // set the new formation
                    setFormation(appPlans[appPlan].platform.instance, appPlans[appPlan].app_name, plannedFormation)
                    // log the changes
                    console.log(`current formation for ${appPlans[appPlan].app_name} is type: ${currentFormation.type}, size: ${currentFormation.size}, quantity: ${currentFormation.quantity}`)
                    console.log(`planned formation for ${appPlans[appPlan].app_name} is type: ${plannedFormation.type}, size: ${plannedFormation.size}, quantity: ${plannedFormation.quantity}`)
                    console.log(`Formation updated for ${appPlans[appPlan].app_name} to type: ${plannedFormation.type}, size: ${plannedFormation.size}, quantity: ${plannedFormation.quantity}`)
                }
            }
            if (appPlans[appPlan].platform.name === 'dots') {
                // fetch the planned formation for the current minute
                let plannedFormation = formations.find(item => item.id == appPlans[appPlan].plannedFormation[index])
                let appId=await getAppId(appPlans[appPlan].platform.instance, appPlans[appPlan].app_name)
                if (plannedFormation.quantity == 0 && appId) {
                    // updateApp(appPlans[appPlan].platform.instance,appPlans[appPlan].app_name, appPlans[appPlan].app_spec)
                    deleteApp(appPlans[appPlan].platform.instance,appPlans[appPlan].app_name)
                } else if (plannedFormation.quantity == 1 && !appId) {
                    createApp(appPlans[appPlan].platform.instance,appPlans[appPlan].app_name, appPlans[appPlan].app_spec)
                }
            }

            // trigger restart check for the application
            if (appPlans[appPlan].restart.enabled === true)
                m = await autoRestart(
                    appPlans[appPlan].platform.name, 
                    appPlans[appPlan].platform.instance, 
                    appPlans[appPlan].app_name,
                    appPlans[appPlan].restart.app_domain, 
                    appPlans[appPlan].restart.api_key,
                    appPlans[appPlan].app_spec)

        } catch (e) {
            console.log(`Exception occured while processing ${appPlans[appPlan].app_name}, platform - ${JSON.stringify(appPlans[appPlan].platform)} - ${e}`)
        }
        for (key in m) {
            data[key]=m[key]
        }
    } // appPlans

    if (isMarketOpen(index)) 
        pushmetrics(data)
}

async function main() {

    pushmetrics(metrics={})
    // sanity checks
    if (!uri || !dbName || !port) {
        console.log(`Couldn't start the application. Contact your admin!`)
        console.debug(` uri - ${uri}, db - ${dbName}, port - ${port}`)
        return
    }

    // start the express server
    app.listen(port)

    // fetch the configurations
    now = new Date()
    getConfig(now).catch(console.error)

    // daily job
    const job1 = schedule.scheduleJob('0 0 * * *', function (fireDate) {
        getConfig(fireDate).catch(console.error)
    })

    // minute job
    const job2 = schedule.scheduleJob('*/1 * * * *', function (fireDate) {
        autoScale(fireDate).catch(console.error)
    })

}

main()