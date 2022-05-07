const { MongoClient } = require('mongodb')
const Heroku = require('heroku-client')
const schedule = require('node-schedule')
const express = require('express')
const moment = require('moment')
const axios = require('axios').default;
require('dotenv').config()

// initialize environment variables
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
            console.log(`Market holiday today(${date})`)
        else
            console.log(`Not a market holiday today(${date})`)

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
        console.log(`formations - ${JSON.stringify(formations)}\nplans - ${JSON.stringify(plans)}\nappPlans - ${JSON.stringify(appPlans)}\nholidays for ${year} - ${holidaysForYear.holidays}`)
    } catch (e) {
        console.error(e)
    } finally {
        await client.close()
    }
    fetchingConfig = false
}

async function getFormation(platform, appName) {
    const formations = await platform.get(`/apps/${appName}/formation`)
    return formations[0]
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

async function autoRestart(platform, appName, apiKey) {
    url = `https://${appName}.herokuapp.com/restart`
    let response;
    try{
        response = await axios.get(url, {headers: {'X-API-KEY': apiKey }});
        if (response.data.flag) {
            console.log(`restart flag detected for ${appName} - ${response.data.flag}. Restarting...`)
            restartDyno(platform, appName)
        }
    } catch (error) {
        // console.error(error);
    }
}

async function autoScale(fireDate) {
    if (fetchingConfig) {
        console.log('Confguration is getting updated. Skipping the autoscale process...')
        return
    }
    var minutes = fireDate.getMinutes()
    var hour = fireDate.getHours()
    var index = hour * 60 + minutes

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
                // trigger restart check for the application
                if (appPlans[appPlan].restart.enabled === true)
                    autoRestart(appPlans[appPlan].platform.instance, appPlans[appPlan].app_name, appPlans[appPlan].restart.api_key)
            }

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
        } catch (e) {
            console.log(`Exception occured while processing ${appPlans[appPlan].app_name}, platform - ${JSON.stringify(appPlans[appPlan].platform)} - ${e}`)
        }
    }
}

async function main() {
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