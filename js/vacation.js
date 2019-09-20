const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);
const destination = "Aspen";
const source = "Tel-Aviv";
const hotelsToExclude = ["Leonardo"];

//
// define and validate data sources
//
let stream = bc.Datastore.getStream("Vacation.Example.IdealVacationData");
if (!stream) {
    stream = bc.Datastore.defineStream(
        {
            "source": "Vacation.Example.IdealVacationData",//source name
            "adapter": BC.Utils.SourceAdapters.createS3Adapter( // adapter for fetching a CSV file from AWS S3 of the required data prepared from sources of weather reports for past decade and available hotel rooms, available flight seats and personal calender events for the next year
                "AWS AKIAIOSFODNN7EXAMPLE:bWq2s1WEIj+Ydj0vQ697zp+IXMU=", //authorization string
                "vacation", // S3 bucket
                "vacationData.csv", // S3 object
                "CSV" // object type
            ),
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
                "dayOfYear":    "the day of the year represented by a number between 1 and 365",
                "depth":        "the average snow depth on the associated day over the past 10 year period",
                "hotelName":    "the name of a hotel at the destination",
                "hotelPrice":   "the price of an available room in hotelName on the associated day",
                "availability": "true if there are no calendar events on the associated day, otherwise false",
                "isHoliday":    "true if the associated day is a holiday, otherwise false",
                "flightPrice":  "the price of a flight to destination on the associated day (will be undefined if there are no available flights on this day)",
                "destination":  "the flight's destination (will be undefined if there are no available flights on this day)"
            },
        }
    );
    if (!stream || !stream.validate()) {
        throw "Example stream cannot be accessed, reason: " + stream.validationErrorMsg;
    }
}

//
// build scanner
//
if (!stream.getScanner("myIdealVacationTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the stream
    let scanner = stream.createScanner();
    scanner.addConstraint("constraint1Week", // constraint name
        function(curSequence) {
            let numOfDays = curSequence.records.length;
            for (let i = 1; i < numOfDays; i++) { // verify that all days are consecutive. This is necessary because consecutive records may correspond to the same day (corresponding to different hotels/flights) or to days that aren't consecutive (recall that the stream will not posses a record for days on which there were no available hotel rooms)
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

// run our scanner on the stream
stream.scan("myIdealVacationTheory");
