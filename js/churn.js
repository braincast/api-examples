const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);

const ChurnAdapterTemplate = {
    openAPISpec: Examples.OpenAPI.JSON.Churn, // the Open API Specification (OAS) of a REST data source for accessing the churn user data
    path:"/query",  // the HTTP endpoint to use from the OAS spec
    operation:"get",  // the HTTP method to use
    params:{     // required values for parameters specified in the OAS
        "apikey":     "AKIAIOSFODNNSLOE:Yxg83MZaEgh3OZ3l0rLo5RTX11o="
    }
};

//
// define and validate data sources
//
let transactionsStream = bc.Datastore.getStream("Churn.Example.transactions");
if (!transactionsStream) {
    transactionsStream = bc.Datastore.defineStream(
        "Churn.Example.transactions",//source name
        BC.Utils.SourceAdapters.createREST(ChurnAdapterTemplate, {"params": {"function": "transactions"}}),// Reuse adapter to fetch data for user transactions (i.e. subscriptions/cancellations)
        [// specify which fields of the records being fetched from the source should be used to make up the stream's output record (if omitted, all fields will be used)
            "transaction_date",         // day of transaction (formatted as YYYYMMDD)
            "msno",                     // unique user identifier
            "payment_plan_days",        // number of days in subscription period
            "membership_expire_date",   // day on which the current subscription expires
            "is_cancel",                 // 0 if the transaction represents a new/re-newed subscription or 1 if it represents a cancellation of subscription
            "is_auto_renew"              // 0 if the transaction represents a manual subscription renewal or 1 if it represents either an automatic subscription renewal or a cancellation of subscription
        ]
    );
    if (!transactionsStream || !transactionsStream.validate()) {
        throw "Access to Churn user transactions data feed does not work, reason: " + transactionsStream.validationErrorMsg;
    }
}
let userLogStream = bc.Datastore.getStream("Churn.Example.userLogs");
if (!userLogStream) {
    userLogStream = bc.Datastore.defineStream(
        "Churn.Example.userLogs",
        BC.Utils.SourceAdapters.createREST(ChurnAdapterTemplate, {"params": {"function": "user_logs"}}),// Reuse adapter to fetch data for the user daily user logs describing listening activity
        [
            "date",         // day of activity (formatted as YYYYMMDD)
            "msno",         // unique user identifier
            "num_25",       // # of songs played less than 25% of the song length
            "num_50",       // # of songs played between 25% to 50% of the song length
            "num_75",       // # of songs played between 50% to 75% of of the song length
            "num_985",      // # of songs played between 75% to 98.5% of the song length
            "num_100",      // # of songs played over 98.5% of the song length
            "total_secs"    // total amount of seconds the user listened to on this day
        ]
    );
    if (!userLogStream || !userLogStream.validate()) {
        throw "Access to Churn user logs data feed does not work, reason: " + userLogStream.validationErrorMsg;
    }
}

// -----------   Learn to identify user churn behaviour that differs from behaviour of non-churning users:   -----------
//
// build data view to learn from
//
let viewOutput = { //Define the view's output:
    "outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attributes and the value is that attribute's description
        "date": "the day at which the record's data occurs",
        "userId": "the user's identifier",
        "totalHours": "the number of total listening hours rounded to the nearest integer",
        "totalSongs": "the total number of songs listened to",
        "isCancel": "true if there was a cancellation transaction on this day, otherwise false",
        "isAutoRenew": "true if there was an automatic subscription renewal transaction on this day, otherwise false",
        "paymentPlanDays": "number of days in the current subscription period",
        "currentSubscriptionEnd": "the day that the subscription on this day ends",
        "nextSubscriptionDate": "the day that the user renewed the subscription after the current subscription ended"
    },
    "outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the pipe's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).

        let usersSubscriptionPeriods = findUsersSubscriptionPeriods(inputRecordQueues["transactions"]);
        // Merge the two input record queues into an output record queue while synchronizing according to the date and user id (i.e. user log and transaction records for the same user that occurred on the same day will be combined into a single record):
        let outputRecordsQueue = [];
        let transactions = inputRecordQueues["transactions"];
        let userLogs = inputRecordQueues["userLogs"];
        let i = 0, j = 0, date, userId, totalHours, totalSongs, isCancel, isAutoRenew, currentSubscriptionEnd;
        while (i < transactions.length && j < userLogs.length) {
            date =   userLogs[j]["date"];
            userId = userLogs[j]["msno"];
            currentSubscriptionEnd = getSubscriptionInfoForDate(usersSubscriptionPeriods[userId],date,"currentSubscriptionEnd");
            let isValidUserLog = isValidUserLog(userLogs[j],currentSubscriptionEnd);
            totalHours =  isValidUserLog ? userLogs[j]["total_secs"] / 3600 : undefined;
            totalSongs =  isValidUserLog ? getTotalSongs(userLogs[j]) : undefined;
            isCancel =    transactions[i]["is_cancel"];
            isAutoRenew = transactions[i]["is_auto_renew"];
            if (transactions[i]["msno"] === userLogs[j]["msno"] &&          // same user
                transactions[i]["transaction_date"] === userLogs[j]["date"])// same day
            {
                i++;
                j++;
            } else if (transactions[i]["transaction_date"] >= userLogs[j]["date"]) { // add an output record only for the current user log (with missing transaction related attribute values):
                if(isValidUserLog){
                    isCancel =    undefined;
                    isAutoRenew = undefined;
                }else{
                    date = undefined; // this is needed so we don't add an output record corresponding to invalid user log records
                }
                j++;
            } else {  // add an output record only for the current transaction (with missing user log related attribute values):
                date = transactions[i]["transaction_date"];
                userId = transactions[i]["msno"];
                currentSubscriptionEnd =  getSubscriptionInfoForDate(usersSubscriptionPeriods[userId],date,"currentSubscriptionEnd");
                totalHours =  undefined;
                totalSongs =  undefined;
                i++;
            }
            if(date){
                outputRecordsQueue.push({
                    "date":                   date,
                    "userId":                 userId,
                    "totalHours":             totalHours,
                    "totalSongs":             totalSongs,
                    "isCancel":               isCancel,
                    "isAutoRenew":            isAutoRenew,
                    "paymentPlanDays":        getSubscriptionInfoForDate(usersSubscriptionPeriods[userId],date,"paymentPlanDays"),
                    "currentSubscriptionEnd": currentSubscriptionEnd,
                    "nextSubscriptionDate":   getSubscriptionInfoForDate(usersSubscriptionPeriods[userId],date,"nextSubscriptionDate")
                });
            }
        }
        return outputRecordsQueue;
    }
};
let learningView = bc.Datastore.getView("Churn.Example.view.learning");
if (!learningView) {//Create a view of data between 1-10-2016 and 31-3-2017 to learn from:
    learningView = bc.Datastore.createView(
        {
            "inputSources": {// the sources of records inputted to the view
                "transactions": {
                    "source": transactionsStream,// the actual source
                    "filter": {"where": "transaction_date <= 20170331 AND transaction_date >= 20161001"}  // the filter for this source specifying that only transactions between 1-10-2016 and 31-3-2017 should be consumed
                },
                "userLogs": {
                    "source": userLogStream,
                    "filter": {"where": "date <= 20170331 AND date >= 20161001"}
                }
            },
            "rate": BC.Meta.Period.Once,  // the input consumption rate specifying that all available data from all the input sources should be consumed once so as to always learn from the same data
        },
        viewOutput
    );
    if (!learningView.validate()) {
        throw "Learning view does not work, reason: " + view.validationErrorMsg;
    }
    learningView.save("Churn.Example.view.learning");
}

// Build data view of the currently subscribed users' data:
let predictionView = bc.Datastore.getView("Churn.Example.view.prediction");
if(!predictionView){
    predictionView = bc.Datastore.createView(
    {
        "inputSources": {// the sources of records inputted to the view
            "transactions": {
                "source": transactionsStream,// the actual source
                "filter": {"where": "DATE(transaction_date,'YYYYMMDD') >= CURDATE(-3)"}  // the filter for this source specifying that only transactions for the past 3 months should be consumed
            },
            "userLogs": {
                "source": userLogStream,
                "filter": {"where": "DATE(transaction_date,'YYYYMMDD') >= CURDATE(-3)"}
            }
        },
        "rate": BC.Meta.Period.Week,  // the input consumption rate specifying that all available data from all the input sources should be consumed once every week (or BC.Meta.Period.Once which is also the default)
    },
    viewOutput
    );
    if (!predictionView.validate()) {
        throw "Prediction view does not work, reason: " + view.validationErrorMsg;
    }
    predictionView.save("Churn.Example.view.prediction");
}

// Specify constraints that define which data instances in both learning and prediction views should be analyzed (i.e. to learn from and make predictions about)
// IMPORTANT NOTE: these constraints must be defined over attributes that are common to the records of both learning and prediction views!
let instanceConstraints = [
    BC.Meta.Functions.Constraints.newConstraint(
        "user14DaySequence", // constraint name
        function (curSequence) {
            return  curSequence.records.length === 14 &&
                    curSequence.records.every(rec=>rec["userId"]===curSequence.records[0]["userId"]);
        },
        "instance is a specific user's 14 day long sequence", // explanation
    ),
    BC.Meta.Functions.Constraints.newMaximalValueConstraint(
        "mostRecentSequence",
        function (curSequence) { //  evaluator function - a function whose returned value will be used to select one of all possible sequences satisfying all other constraints
            let avgDate = 0;
            curSequence.records.forEach(rec=>avgDate+=rec["date"]);
            return  avgDate / curSequence.records.length;
        },
        "instance is the most recent sequence (with the latest average date of all records)"
    )
];

// Specify constraints that check whether or not an instance in the learning view represents a certain type:
let typeConstraints = [
    BC.Meta.Functions.Constraints.newConstraint(
        "churn", // constraint name
        function (curSequence) {
            let lastDayRec = curSequence.records[curSequence.records.length-1];
            return  lastDayRec["currentSubscriptionEnd"] >= 20170201 && lastDayRec["currentSubscriptionEnd"] <= 20170301 && // the last day is within a user's subscription period which ends in Feb. 2017
                (!lastDayRec["nextSubscriptionDate"] || // and this user did not have another subscription period after Feb. 2017
                    numOfDaysBetween(lastDayRec["currentSubscriptionEnd"],lastDayRec["nextSubscriptionDate"] > 30)) // or this user had another subscription period but it began more than 30 days after the previous subscription period ended
        },
        "churn users who had a subscription ending in Feb. 2017 which the user either renewed more than 30 days after the subscription ended or didn't renew at all" // explanation
    ),
    BC.Meta.Functions.Constraints.newConstraint(
        "not churn", // constraint name
        function (curSequence) {
            let lastDayRec = curSequence.records[curSequence.records.length-1];
            return  lastDayRec["currentSubscriptionEnd"] >= 20170201 && lastDayRec["currentSubscriptionEnd"] <= 20170301 && // the last day is within a user's subscription period which ends in Feb. 2017
                (!lastDayRec["nextSubscriptionDate"] || // and this user did not have another subscription period after Feb. 2017
                    numOfDaysBetween(lastDayRec["currentSubscriptionEnd"],lastDayRec["nextSubscriptionDate"] > 30)) // or this user had another subscription period but it began more than 30 days after the previous subscription period ended
        },
        "An instance in the learning view is of type 'not churn' if it corresponds to a user who had a subscription ending in Feb. 2017 which the user renewed within 30 days" // explanation
    )
];

// Build a prediction scanner that can scan the behaviour of the currently subscribed users in the prediction view and predict which users are likely to churn:
let predictionScanner = bc.Datastore.getScanner("Churn.Example.churnPredictor");
if (!predictionScanner) {
    predictionScanner = bc.Datastore.createPredictionScanner(
        learningView, // the view from which the scanner will learn to how to predict an instance's type
        predictionView, // the view containing the instances whose type needs to be predicted.
        instanceConstraints, // constraints that define what a data instance is in both learning and prediction views, i.e. must be defined over attributes that are common to the records of both learning and prediction views
        typeConstraints // constraints that define the different types of data instances (an instance may be of one, many or none of these types)
    );
    if (!predictionScanner.validate()) {
        throw "Scanner not configured properly, reason: " + predictionScanner.validationErrorMsg;
    }

    predictionScanner.settings = {
        "schedule": BC.Meta.Period.Week, // or BC.Meta.Period.Once which is the default
        "predict": "churn", // set the type of user behaviour to predict by specifying one of the type constraint's name
        "activation": BC.Utils.ActionAdapters.createJSCallback(function (result) {
            let predictedUserSequence = result.value;
            let probability = Number.parseFloat(result.probability) * 100;
            alert(`User: ${predictedUserSequence.records[0]["userId"]} is ${probability}% likely to churn because" + ${result.explanation}`);
        })
    };

    predictionScanner.save("Churn.Example.churnPredictor");
}

// start predicting churn users:
predictionScanner.predict();

//
// helper functions
//
function findUsersSubscriptionPeriods(transactions) {
    let usersSubscriptionPeriods = {};
    for(let i=0;i<transactions.length;i++){
        let id = transactions[i]["msno"];
        // Set this user's last subscription period's end date to the date of the current transaction if the current transaction occurred before it (can happen when this is a pre-mature subscription renewal or cancellation, i.e. happens before the period's expiration date):
        if(!usersSubscriptionPeriods[id] && transactions[i]["transaction_date"] < usersSubscriptionPeriods[id][usersSubscriptionPeriods[id].length-1]["end"]){
            usersSubscriptionPeriods[id][usersSubscriptionPeriods[id].length-1]["end"] = transactions[i]["transaction_date"];
        }
        if (transactions[i]["is_cancel"] === 0) {//if the user is subscribing, this is the start of a subscription period
            if (!usersSubscriptionPeriods[id]) {
                usersSubscriptionPeriods[id] = [];
            }
            // Add the new subscription period:
            usersSubscriptionPeriods[id].push({
                "start":transactions[i]["transaction_date"],
                "end":  transactions[i]["membership_expire_date"],
                "paymentPlanDays":  transactions[i]["paymentPlanDays"]
            });
        }
    }
    return usersSubscriptionPeriods;
}
function getSubscriptionInfoForDate(subscriptionPeriods, date, infoToGet) {
    if(!subscriptionPeriods || subscriptionPeriods.length===0){ // if there are no subscription periods, return undefined
        return undefined;
    }
    for(let i=0;i<subscriptionPeriods.length;i++){
        if(date>=subscriptionPeriods[i]["start"] && date<=subscriptionPeriods[i]["end"]) {
            switch (infoToGet) {
                case "nextSubscriptionDate":
                    return subscriptionPeriods[i + 1] ? subscriptionPeriods[i + 1]["start"] : undefined;
                case "currentSubscriptionEnd":
                    return subscriptionPeriods[i]["end"];
                case "paymentPlanDays":
                    return subscriptionPeriods[i]["paymentPlanDays"];
            }
        }
    }
    return undefined;
}
function isValidUserLog(userLog, expirationDate) {
    return numOfDaysBetween(userLog["date"],expirationDate) < 0 && //verify that the user log record did not occur after the subscription expiration date (this is an illegal user log record)
            userLog["total_secs"] / 3600 <= 24;
}
function getTotalSongs(userLog) {
    return userLog["num_25"] + userLog["num_50"] + userLog["num_75"] + userLog["num_985"] + userLog["num_100"];
}
function getDateFromString(date1Str) {
    return new Date(Number.parseInt(date1Str.slice(0, 4)), Number.parseInt(date1Str.slice(4, 6)), Number.parseInt(date1Str.slice(6, 8)));
}
function numOfDaysBetween(date1Str, date2Str) {
    let oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
    let date1 = getDateFromString(date1Str);
    let date2 = getDateFromString(date2Str);
    return Math.round((date1.getTime() - date2.getTime()) / (oneDay));
}

