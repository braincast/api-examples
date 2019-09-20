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
let learningStream = bc.Datastore.getStream("Churn.Example.UserTransactionAndActivity");
if (!learningStream) {//Create a stream of user transactions and listening activity between 1-10-2016 and 31-3-2017 to learn from:
    learningStream = bc.Datastore.defineStream(
        {
            "source": "Churn.Example.Learning",//source name
            "adapter": BC.Utils.SourceAdapters.createREST(ChurnAdapterTemplate,{"params": {"function": "user_transactions_and_listening_activity"}}),
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
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
            "filter": {"where": "date >= 20161001 AND date <= 20170331"}, // the filter for this source specifying that only the records between 1-10-2016 and 31-3-2017 should be consumed
        }
    );
    if (!learningStream || !learningStream.validate()) {
        throw "Example learning stream cannot be accessed, reason: " + learningStream.validationErrorMsg;
    }
}

let predictionStream = bc.Datastore.getStream("Churn.Example.UserTransactionAndActivity");
if (!predictionStream) {//Create a stream of user transactions and listening activity between 1-10-2016 and 31-3-2017 to learn from:
    predictionStream = bc.Datastore.defineStream(
        {
            "source": "Churn.Example.Learning",//source name
            "adapter": BC.Utils.SourceAdapters.createREST(ChurnAdapterTemplate,{"params": {"function": "user_transactions_and_listening_activity"}}),
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
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
            "filter": {"where": "DATE(date,'YYYYMMDD') >= CURDATE(-3)"},  // the filter for this source specifying that only records for the past 3 months should be consumed
            "rate": BC.Meta.Period.Week,  // the input consumption rate specifying that all available data records should be consumed once every week
        }
    );
    if (!predictionStream || !predictionStream.validate()) {
        throw "Example prediction stream cannot be accessed, reason: " + predictionStream.validationErrorMsg;
    }
}

// Specify constraints that define which data instances in both learning and prediction streams should be analyzed (i.e. to learn from and make predictions about)
// IMPORTANT NOTE: these constraints must be defined over attributes that are common to the records of both learning and prediction streams!
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

// Specify constraints that check whether or not an instance in the learning stream represents a certain type:
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
        "An instance in the learning stream is of type 'not churn' if it corresponds to a user who had a subscription ending in Feb. 2017 which the user renewed within 30 days" // explanation
    )
];

// Build a prediction scanner that can scan the behaviour of the currently subscribed users in the prediction stream and predict which users are likely to churn:
let predictionScanner = bc.Datastore.getScanner("Churn.Example.churnPredictor");
if (!predictionScanner) {
    predictionScanner = bc.Datastore.createPredictionScanner(
        learningStream, // the stream from which the scanner will learn to how to predict an instance's type
        predictionStream, // the stream containing the instances whose type needs to be predicted.
        instanceConstraints, // constraints that define what a data instance is in both learning and prediction streams, i.e. must be defined over attributes that are common to the records of both learning and prediction streams
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

