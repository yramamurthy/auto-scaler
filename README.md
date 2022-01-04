# auto-scaler

A very simple auto scaler that scale the Heroku Dynos in minute granularity based on 
- user configuration (stored in the managed database)
- market holidays

This is an alternative to [FlightFormation](https://elements.heroku.com/addons/flightformation) Heroku add-on. Works on all Dyno types like Free, Hobby, Standard, Performance, etc. Primary goal of this project is to reduce the billable Dyno hours and hence the cost payable to Heroku services!