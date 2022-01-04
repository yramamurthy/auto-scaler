# auto-scaler

A very simple auto scaler that scale the Heroku Dynos in minute granularity based on 
- user configuration (stored in the managed database)
- market holidays

This is an alternative to [FlightFormation](https://elements.heroku.com/addons/flightformation) Heroku add-on. Works on all Dyno types like Free, Hobby, Standard, Performance, etc. Primary goal of this project is to reduce the billable Dyno hours and hence the cost payable to Heroku services!

## Environment variables

HEROKU_API_TOKEN -> Token to call Heroku platform services
DATABASE_URL -> URI of the database where user configuration and market holidays are persisted
DATABASE_NAME -> Name of the database where user configuration and market holidays are persisted
TZ -> Timezone to be used for scaling purposes