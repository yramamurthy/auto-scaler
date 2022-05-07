# auto-scaler

A very simple auto scaler application that scale the Heroku Dynos in minute granularity based on 
- daily schedule
- market holidays

This auto-scaler is an alternative to [FlightFormation](https://elements.heroku.com/addons/flightformation) Heroku add-on and works with all Dyno types like Free, Hobby, Standard, Performance, etc. Primary goal of this project is to reduce the billable Dyno hours(and hence the cost payable to Heroku services) based on user provided configurations. The user provided configurations are managed in a Mongo DB. 

## Environment variables

Following variables should be set for the application to work properly.

|Variable|Description|
|---|---|
|DATABASE_URL|URI of the database where user configuration and market holidays are persisted|
|DATABASE_NAME|Name of the database where user configuration and market holidays are persisted|
|TZ|Timezone to be used for scaling purposes|
