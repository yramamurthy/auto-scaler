const { MongoClient } = require('mongodb')
const Heroku = require('heroku-client')
const schedule = require('node-schedule')
const express = require('express')

// initialize environment variables
const token = process.env.HEROKU_API_TOKEN
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

async function getConfig(fireDate) {
    const client = new MongoClient(uri);
    const weekDay = dayOfWeek[fireDate.getDay()]
    const year = fireDate.getFullYear()
    const date = fireDate.toISOString().slice(0, 10)

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

async function autoScale(fireDate) {
    var minutes = fireDate.getMinutes()
    var hour = fireDate.getHours()
    var index = hour * 60 + minutes

    // loop through the applications configured to auto scale
    for (let appPlan in appPlans) {
        let heroku

        try {
            // platform 
            if (appPlans[appPlan].platform.name == 'heroku') {
                heroku = new Heroku({ token: appPlans[appPlan].platform.token })
            }
            else {
                console.log(`undefined platform for the app - ${appPlans[appPlan].platform.name}`)
                continue
            }

            // fetch the current formation for the configured application
            let currentFormation = await getFormation(heroku, appPlans[appPlan].app_name)

            // fetch the planned formation for the current minute
            let plannedFormation = formations.find(item => item.id == appPlans[appPlan].plannedFormation[index])

            // check if the planned formation differ from the current formation
            if (plannedFormation.type != currentFormation.type ||
                plannedFormation.size != currentFormation.size ||
                plannedFormation.quantity != currentFormation.quantity) {
                // set the new formation
                setFormation(heroku, appPlans[appPlan].app_name, plannedFormation)
                // log the changes
                console.log(`current formation for ${appPlans[appPlan].app_name} is type: ${currentFormation.type}, size: ${currentFormation.size}, quantity: ${currentFormation.quantity}`)
                console.log(`planned formation for ${appPlans[appPlan].app_name} is type: ${plannedFormation.type}, size: ${plannedFormation.size}, quantity: ${plannedFormation.quantity}`)
                console.log(`Formation updated for ${appPlans[appPlan].app_name} to type: ${plannedFormation.type}, size: ${plannedFormation.size}, quantity: ${plannedFormation.quantity}`)
            }
        } catch (e) {
            console.log(`Exception occured while processing ${appPlans[appPlan].app_name}, platform - ${JSON.stringify(appPlans[appPlan].platform)}`)
        }
    }
}

async function main() {
    // sanity checks
    if (!token || !uri || !dbName || !port) {
        console.log(`Couldn't start the application. Contact your admin!`)
        console.debug(`token - ${token}, uri - ${uri}, db - ${dbName}, port - ${port}`)
        return
    }

    // start the express server
    app.listen(port)

    // fetch the configurations
    now = new Date()
    getConfig(now).catch(console.error)

    // daily job
    const job1 = schedule.scheduleJob('3 0 * * *', function (fireDate) {
        getConfig(fireDate).catch(console.error);
    })

    // minute job
    const job2 = schedule.scheduleJob('*/1 * * * *', function (fireDate) {
        autoScale(fireDate)
    })
}

main()