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

//
// define and validate data sources
//
let aaplStream = bc.Datastore.getStream("Stocks.Example.AAPL");
if (!aaplStream) {
    aaplStream = bc.Datastore.defineStream(
        "Stocks.Example.AAPL",//source name
        BC.Utils.SourceAdapters.createREST(alphaVantageAdapterTemplate, {"params": {"symbol": "AAPL"}}),// Reuse adapter to fetch data for Apple stocks
        ["Timestamp", "Price", "Volume"] // specify which fields of the records being fetched from the source should be used to make up the stream's output record (if omitted, all fields will be used)
    );
    if (!aaplStream || !aaplStream.validate()) {
        throw "Access to AAPL stocks example feed does not work, reason: " + aaplStream.validationErrorMsg;
    }
}
let idxStream = bc.Datastore.getStream("Stocks.Example.QQQ");
if (!idxStream) {
    idxStream = bc.Datastore.defineStream(
        "Stocks.Example.QQQ", //source name
        BC.Utils.SourceAdapters.createREST(alphaVantageAdapterTemplate, {"params": {"symbol": "QQQ"}}),// Reuse adapter to fetch data for NASDAQ index
        ["Timestamp", "Price"] //fields from source to use in stream's output records
    );
    if (!idxStream || !idxStream.validate()) {
        throw "Access to QQQ stocks example feed does not work, reason: " + idxStream.validationErrorMsg;
    }
}

//
// build view
//
let view = bc.Datastore.getView("Stocks.Example.view");
if (!view) {
    //Create a view that outputs bulks of the last minute data combined from the streams, every minute:
    let lastMinuteFilter = {"where": "Timestamp > CURTIME() - 60000"};
    view = bc.Datastore.createView(
        {
            "inputSources": {// the sources of records inputted to the view (in other cases some of the input sources can be another view instead of a data source)
                "apple": {
                    "source": aaplStream,      // the actual source
                    "filter": lastMinuteFilter // the filter for this source specifying that only the apple stock data for the last minute should be consumed
                },
                "idx": {
                    "source": idxStream,
                    "filter": lastMinuteFilter
                }
            },
            "rate": BC.Meta.Period.Min,  // the input consumption rate specifying that all available data from all the input sources  should be consumed once every minute (or BC.Meta.Period.Once which is the default)
        },
        {
            "outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attribute and the value is that attribute's description
                "timestamp": "the timestamp at which the record's data occurs",
                "stockCng": "the difference between the current and previous price of the stock",
                "stockAvgCng": "the average of all stock change values occurring in the last minute",
                "ratioStockVol": "the the current stock volume divided by the average stock volume in the last minute",
                "idxCng": "the difference between the current and previous price of the index",
                "idxAvgCng": "the average of all index change values occurring in the last minute"
            },
            "outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the view's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).
                let syncedRecordsQueue = [];
                let outputRecordsQueue = [];
                let applRecs = inputRecordQueues["apple"];
                let idxRecs = inputRecordQueues["idx"];
                let i = 0, j = 0, nOut = 0, stockAvgCng = 0, stockAvgVol = 0, idxAvgCng = 0, stockCng, idxCng;
                while (i < applRecs.length && j < idxRecs.length) {
                    if (applRecs[i].Timestamp === idxRecs[j].Timestamp) {
                        syncedRecordsQueue[nOut] = {
                            "timestamp": applRecs[i].Timestamp,
                            "stockPrice": applRecs[i].Price,
                            "stockVol": applRecs[i].Volume,
                            "idxPrice": idxRecs[j].Price
                        };
                        if (nOut > 0) {
                            stockCng = syncedRecordsQueue[nOut].stockPrice - syncedRecordsQueue[nOut - 1].stockPrice;
                            idxCng = syncedRecordsQueue[nOut].idxPrice - syncedRecordsQueue[nOut - 1].idxPrice;
                            if (nOut === 1) {
                                stockAvgCng = stockCng;
                                idxAvgCng = idxCng;
                                stockAvgVol = syncedRecordsQueue[nOut].stockVol;
                            } else {
                                stockAvgCng = (outputRecordsQueue[nOut - 2].stockAvgCng * (nOut - 1) + stockCng) / nOut;
                                idxAvgCng = (outputRecordsQueue[nOut - 2].idxAvgCng * (nOut - 1) + idxCng) / nOut;
                                stockAvgVol = (outputRecordsQueue[nOut - 2].stockAvgVol * (nOut - 1) + syncedRecordsQueue[nOut].stockVol) / nOut;
                            }
                            outputRecordsQueue[nOut - 1] = {
                                "timestamp": syncedRecordsQueue[nOut].timestamp,
                                "stockCng": stockCng,
                                "stockAvgCng": stockAvgCng,
                                "ratioStockVol": syncedRecordsQueue[nOut].stockVol / stockAvgVol,
                                "idxCng": idxCng,
                                "idxAvgCng": idxAvgCng
                            };
                        }
                        i++;
                        j++;
                        nOut++
                    } else if (applRecs[i].Timestamp > idxRecs[j].Timestamp) {
                        j++;
                    } else {
                        i++;
                    }
                }
                return outputRecordsQueue; //note that in this case, we throw away records from one source that don't sync with records from the other source.
            }
        }
    );

    if (!view.validate()) {
        throw "View does not work, reason: " + view.validationErrorMsg;
    }

    view.save("Stocks.Example.view", false); // second parameter is whether to override an existing view
}

//
// build scanner
//
if (!view.getScanner("mytrendingtheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the view
    let scanner = view.createScanner();
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

// run our scanner on the view
view.scan("mytrendingtheory");