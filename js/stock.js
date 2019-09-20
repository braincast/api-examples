const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);

const alphaVantageAdapterTemplate = {
    openAPISpec: Examples.OpenAPI.JSON.Alphavantage.Intraday, // the Open API Specification (OAS) for our REST data source
    path: "/query",  // the HTTP endpoint to use from the OAS spec
    operation: "get",  // the HTTP method to use
    params: {     // required values for parameters specified in the OAS
        "function": "TIME_SERIES_DAILY_ADJUSTED",
        "interval": "1sec", //Get 1 second ticks
        "apikey": "AKIAIOSFODNNSLOE:Yxg83MZaEgh3OZ3l0rLo5RTX11o="
    }
};

let pastDayFilter = {"where":"created_at > "+new Date().getTime()+" - 1000*60*60*24"};

//
// define and validate data source
//
let stream = bc.Datastore.getStream("Stocks.Example.AAPLandQQQ");
if (!stream) {
    stream = bc.Datastore.defineStream(
        {
            "source": "Stocks.Example.AAPLandQQQ",//source name
            "adapter": BC.Utils.SourceAdapters.createREST(alphaVantageAdapterTemplate, {"params": {"symbol": ["AAPL", "QQQ"]}}),// Use adapter to fetch data for Apple stock and NASDAQ index
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
                "timestamp": "the timestamp at which the record's data occurs",
                "stockCng": "the difference between the current and previous price of the stock",
                "stockAvgCng": "the average of all stock change values occurring in the last minute",
                "ratioStockVol": "the the current stock volume divided by the average stock volume in the last minute",
                "idxCng": "the difference between the current and previous price of the index",
                "idxAvgCng": "the average of all index change values occurring in the last minute"
            },
            "filter": pastDayFilter, // the filter for this source specifying that only the data for the past day should be consumed
            "rate": BC.Meta.Period.Min  // the input consumption rate specifying that all available data from the input source should be consumed once every minute - can be BC.Meta.Period.Event for continuous consumption of records as they are generated or BC.Meta.Period.Once which is the default.
        }
    );
    if (!stream || !stream.validate()) {
        throw "Example stream cannot be accessed, reason: " + stream.validationErrorMsg;
    }
}

//
// build scanner
//
if (!stream.getScanner("mytrendingtheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the stream
    let scanner = stream.createScanner();
    scanner.addConstraint("constraint10sec", // constraint name
        function (curSequence) {
            return curSequence.records[curSequence.records.length - 1].timestamp - curSequence.records[0].timestamp <= 10000;
        },
        "10 second record sets" // explanation
    );
    scanner.addConstraint("constraintAtLeast3Records",
        function (curSequence) {
            return curSequence.records.length >= 3;
        },
        "record sets with at least 3 records"
    );
    scanner.addConstraint("constraintGrowingVol",
        function (curSequence) {
            return curSequence.records.every(record => record.ratioStockVol > 1);
        },
        "stock volume should be higher than the average volume"
    );
    scanner.addConstraint("constraintPriceHigher",
        function (curSequence) {
            return curSequence.records.every(record => record.stockCng > 1.5 * record.stockCngAvg);
        },
        "change in Apple's stock price for each record should be more than 50% above the average"
    );
    scanner.addConstraint("constraintIndexRising",
        function (curSequence) {
            return curSequence.records.every(record => record.idxCng > 1.5 * record.idxCngAvg);
        },
        "change in nasdaq 100 index stock price for each record should be more than 50% above the average"
    );
    scanner.addConstraint("constraintEndingBehavior",
        function (curSequence) {
            for (let i = 1; i < curSequence.records.length; i++) {
                if (!curSequence.records[i].stockCng > curSequence.records[i - 1].stockCng)
                    return false;
            }
            return true;
        },
        "change in stock price is preferably higher than its value for the previous record"
    );

    scanner.settings = {
        "schedule": BC.Meta.Period.Min, // or BC.Meta.Period.Once which is the default
        "activation": BC.Utils.ActionAdapters.createJSCallback(function (result) {
            alert("Found trend in apple's stock: " + result.value + "\nExplanation: " + result.explanation);
        }),
        "start": "Thu May 02 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // when to start back-test
        "end": "Thu May 09 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // finish back-test after a week
    };
    if (!scanner.validate()) {
        throw "Scanner not configured properly, reason: " + scanner.validationErrorMsg;
    }

    scanner.save("mytrendingtheory", true); // override if such exists
}

// run our scanner on the stream
stream.scan("mytrendingtheory");