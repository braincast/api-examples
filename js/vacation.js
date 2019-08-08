const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);
const destination = "Aspen";
const source = "Tel-Aviv";
const hotelsToExclude = ["Leonardo"];

//
// define and validate data sources
//
let dataSourcesInfo = [ //an array of data source information objects we will use to access, filter and transform the required data:
    {
        "name": "Vacation.Example.Weather",//source name
        "fields": ["Date", "SnowDepth"],
        "openAPITemplate": Examples.Adapters.WeatherOpenAPITemplate,// An Open API Specification template for the weather API
        "params": {"location": destination},// reuse the Open API template by setting the desired location
        "filter": {"where": "Date > CURDATE() - 10"}// extract the weather data only for recent 10 years
    },
    {
        "name": "Vacation.Example.Calander",
        "fields": ["Date", "IsHoliday", "NumberOfEvents"],
        "openAPITemplate": Examples.Adapters.CalendarAPITemplate,
        "params": {"apikey": "AKIAIOSFODNNSLOE:Yxg83MZaEgh3OZ3l0rLo5RTX11o="},
        "filter": {"where": "Date > CURDATE() AND Date < CURDATE() + 1"}// extract one year look ahead data
    },
    {
        "name": "Vacation.Example.Flights",
        "fields": ["Date", "Source", "Destination", "Price"],
        "openAPITemplate": Examples.Adapters.FlightsOpenAPITemplate, // this API only returns data for unreserved seats and there can be multiple records for the same date
        "filter": {
            "where": "((Source = '" + source + "' AND " + "Destination = '" + destination + "') " +
                "OR (Source = '" + destination + "' AND " + "Destination = '" + source + "')) " +
                "AND Date > CURDATE() AND Date < CURDATE() + 1"
        }// extract one year lookahead data for all 2-way flights with available seats

    },
    {
        "name": "Vacation.Example.Hotels",
        "fields": ["Date", "Name", "Price"],
        "openAPITemplate": Examples.Adapters.HotelsAPITemplate, // this API only returns data for available rooms and there can be multiple records for the same date
        "params": {"destination": destination},
        "filter": {"where": "Date > CURDATE() AND Date < CURDATE() + 1"} // extract one year look ahead data for all available rooms in hotels at the destination
    }
];

//
// build view
//
let view = bc.Datastore.getView("Vacation.Example.IdealVacationView");
if (!view) {
    let inputSources = {};
    dataSourcesInfo.forEach(dataSourceInfo =>{
        let stream = bc.Datastore.getStream(dataSourceInfo.name);
        if (!stream) { // if the stream hasn't been previously defined
            stream = bc.Datastore.defineStream(
                dataSourceInfo.name,//source name
                BC.Utils.SourceAdapters.createREST(dataSourceInfo.openAPITemplate, // REST adapter to fetch data from REST API
                                                   {"params": dataSourceInfo.params}), // reuse the Open API template by adding or overriding the relevant parameter values
                dataSourceInfo.fields // specify which fields of the records being fetched from the source should be used to make up the stream's output record (if omitted, all fields will be used)
            );
            if (!stream || !stream.validate()) {
                throw "Access to " + dataSourceInfo.name + " feed does not work, reason: " + stream.validationErrorMsg;
            }
        }
        // Add this stream as an input source to a view required for syncing and transforming the data into view records:
        inputSources[dataSourceInfo.name] = {
            "source": stream,
            "filter": dataSourceInfo.filter  // the filter specifying which data should be consumed from the source
        };
    });
    // Create a view that consumes the data from all 4 streams on a daily basis, combines and transforms the data and outputs records that can be used by the view:
    view = bc.Datastore.createView(
        {
            "inputSources":inputSources,
            "rate":BC.Meta.Period.Day //or BC.Meta.Period.Once which is the default
        },
        {
            "outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attribute and the value is that attribute's description
                "dayOfYear":    "the day of the year represented by a number between 1 and 365",
                "depth":        "the average snow depth on the associated day over the past 10 year period",
                "hotelName":    "the name of a hotel at the destination",
                "hotelPrice":   "the price of an available room in hotelName on the associated day",
                "availability": "true if there are no calendar events on the associated day, otherwise false",
                "isHoliday":    "true if the associated day is a holiday, otherwise false",
                "flightPrice":  "the price of a flight to destination on the associated day (will be undefined if there are no available flights on this day)",
                "destination":  "the flight's destination (will be undefined if there are no available flights on this day)"
            },
            "outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the view's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).
                let daysOfYear = {};
                dataSourcesInfo.forEach(dataSourceInfo =>{
                    let sourceName = dataSourceInfo["name"];
                    inputRecordQueues[sourceName].forEach(inputRecord => {
                        let dayOfYear = date2DayOfYear(inputRecord["Date"]);
                        if(!daysOfYear[dayOfYear]){
                            daysOfYear[dayOfYear]={"depths":[],"flights":[],"isHoliday":false,"availability":false,"hotels":[]};
                        }
                        switch(sourceName){
                            case "Vacation.Example.Weather":
                                daysOfYear[dayOfYear]["depths"].push(inputRecord["SnowDepth"]);
                                break;
                            case "Vacation.Example.Flights":
                                daysOfYear[dayOfYear]["flights"].push(inputRecord);
                                break;

                            case "Vacation.Example.Calendar":
                                daysOfYear[dayOfYear]["isHoliday"] = inputRecord["IsHoliday"]===1;
                                daysOfYear[dayOfYear]["availability"] = inputRecord["NumberOfEvents"] > 0;
                                break;
                            case "Vacation.Example.Hotels":
                                daysOfYear[dayOfYear]["hotels"].push(inputRecord);
                                break;
                        }
                    })
                });
                let outputRecordsQueue = [];
                for(let dayOfYear = 1; dayOfYear <= 365; dayOfYear++){ // add output records in ascending day of year order
                    if(daysOfYear[dayOfYear]) { // verify that data exists for this day
                        let depthForCurDay = average(daysOfYear[dayOfYear]["depths"]);
                        // generate an output record for all (flight,hotel) record pairs for this day:
                        let hotelsForCurDay = daysOfYear[dayOfYear].hotels;
                        let flightsForCurDay = daysOfYear[dayOfYear].flights;
                        for (let i = 0; i < hotelsForCurDay.length; i++) {
                            if(flightsForCurDay.length>0){
                                for (let j = 0; j < flightsForCurDay.length; i++) {
                                    outputRecordsQueue[outputRecordsQueue.length] = {
                                        "dayOfYear":    dayOfYear,
                                        "depth":        depthForCurDay,
                                        "hotelName":    hotelsForCurDay[i]["Name"],
                                        "hotelPrice":   hotelsForCurDay[i]["Price"],
                                        "availability": daysOfYear[dayOfYear]["availability"],
                                        "isHoliday":    daysOfYear[dayOfYear]["isHoliday"],
                                        "flightPrice":  flightsForCurDay[j]["Price"],
                                        "destination":  flightsForCurDay[j]["Destination"]
                                    };
                                }
                            }else{ // if there are no available flights on this day
                                outputRecordsQueue[outputRecordsQueue.length] = {
                                    "dayOfYear":    dayOfYear,
                                    "depth":        depthForCurDay,
                                    "hotelName":    hotelsForCurDay[i]["Name"],
                                    "hotelPrice":   hotelsForCurDay[i]["Price"],
                                    "availability": daysOfYear[dayOfYear]["availability"],
                                    "isHoliday":    daysOfYear[dayOfYear]["isHoliday"]
                                };
                            }
                        }
                    }
                }
                return outputRecordsQueue;
            }
        }
    );

    if (!view.validate()) {
        throw "View does not work, reason: "+view.validationErrorMsg;
    }
    view.save("Vacation.Example.IdealVacationView", false); // second parameter is whether to override an existing view
}

//
// build scanner
//
if (!view.getScanner("myIdealVacationTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the view
    let scanner = view.createScanner();
    scanner.addConstraint("constraint1Week", // constraint name
        function(curSequence) {
            let numOfDays = curSequence.records.length;
            for (let i = 1; i < numOfDays; i++) { // verify that all days are consecutive. This is necessary because consecutive records may correspond to the same day (corresponding to different hotels/flights) or to days that aren't consecutive (recall that the view will not posses a record for days on which there were no available hotel rooms)
                let numOfDaysBetweenRecords = curSequence.records[i].dayOfYear-curSequence.records[i-1].dayOfYear;
                if(numOfDaysBetweenRecords !== 1 ||
                   numOfDaysBetweenRecords !== -364) // in case curSequence.records[i] corresponds to January 1st and curSequence.records[i-1] corresponds to December 31
                {
                    return false;
                }
            }
            return  numOfDays === 7; // vacation must be seven days long
        },
        "sequences corresponding to 7 consecutive days"// explanation
    );
    scanner.addConstraint("constraintCalendarAvailability",
        function(curSequence) {
            return  curSequence.records.every(record => record.availability);
        },
        "calender availability for all days in sequence"
    );
    scanner.addConstraint("constraintAtLeast3Holidays",
        function(curSequence) {
            let numOfHolidays = 0;
            for (let i = 1; i < curSequence.records.length; i++) {
                if (curSequence.records[i].isHoliday)
                    numOfHolidays++;
            }
            return numOfHolidays >= 3;
        },
        "should be at least 3 days corresponding to holidays"
    );
    scanner.addConstraint("constraintSnowfall",
        function(curSequence) {
            let numOfDaysWithSnowfall = curSequence.records.filter(record => record.depth > 0).length;
            return numOfDaysWithSnowfall >= 2 && numOfDaysWithSnowfall < 5;
        },
        "number of days with snowfall should be at least 2 and less than 5"
    );
    scanner.addConstraint("constraintAvgDepth",
        function(curSequence) {
            let avgDepth = 0;
            curSequence.records.forEach(record => avgDepth += record.depth);
            avgDepth /= curSequence.records.length;
            return avgDepth > 2;
        },
        "average depth for all days should be higher than 2 meters"
    );
    scanner.addConstraint("constraintHotel",
        function(curSequence) {
            let hotelName = curSequence.records[0].hotelName;
            if(hotelsToExclude.includes(hotelName))return false;
            let hotelPriceForAllDays = 0;
            for (let i = 0; i < curSequence.records.length; i++) {
                let record = curSequence.records[i];
                if(record.hotelName !== hotelName){  // must be same hotel on all days
                    return false;
                }
                hotelPriceForAllDays += record.hotelPrice
            }
            return hotelPriceForAllDays < 400;
        },
        "same hotel, which can't be any of "+hotelsToExclude+", must be available for all days and the total price should be under 400$"
    );
    scanner.addConstraint("constraintFlights",
        function(curSequence) {
            let firstDay = curSequence.records[0];
            let lastDay = curSequence.records[curSequence.records.length-1];
            return  firstDay.flightPrice && firstDay.destination === destination && // there must be an available flight to the destination on the first day
                    lastDay.flightPrice && lastDay.destination === source && // there must be an available flight back on the last day
                    firstDay.flightPrice + lastDay.flightPrice < 300;
        },
        "there must be a flight to the destination on the first day and a flight back to the source on the last day, such that the total trip cost is under 300$"
    );

    scanner.settings = {
        "schedule" : BC.Meta.Period.Day, // or BC.Meta.Period.once which is the default
        "activation" : BC.Utils.ActionAdapters.createJSCallback(function(result) {
            alert("Found your ideal vacation: "+ result+"\nExplanation: "+result.explanation);
        }),
        "start" : "Thu May 02 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // when to start back-test
        "end" : "Thu May 09 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // finish back-test after a week
    };
    if (!scanner.validate()) {
        throw "Scanner not configured properly, reason: "+scanner.validationErrorMsg;
    }
    scanner.save("myIdealVacationTheory", true); // override if such exists
}

// run our scanner on the view
view.scan("myIdealVacationTheory");

//
// helper functions:
//
function date2DayOfYear(date) {
    return Math.ceil((date - new Date(date.getFullYear(), 0, 1)) / 86400000);
}
function average(array) {
    return array.reduce(function (sum, a) {
        return sum + a
    }, 0) / (array.length || 1);
}
