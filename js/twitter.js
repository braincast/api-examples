const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);
const followers = Examples.Twitter.myFollowers;

const twitterAdapterTemplate = {
	openAPISpec: Examples.OpenAPI.JSON.Twitter, // the Open API Specification (OAS) for our REST data source
	path:"/query",  // the HTTP endpoint to use from the OAS spec
	operation:"get",  // the HTTP method to use
	params:{     // required values for parameters specified in the OAS
		"function":   "statuses/user_timeline",
		"apikey":     "AKIAIOSFODNNSLOE:Yxg83MZaEgh3OZ3l0rLo5RTX11o="
	}
};

//
// define and validate data sources
//
let inputSources = {};
let today = new Date();
let pastWeekFilter = {"where":"created_at > "+today.getTime()+" - 1000*60*60*24*7"};
let stream = bc.Datastore.getStream("Twitter.Example.Activity");
if (!stream) {
    stream = bc.Datastore.defineStream(
        {
            "source": "Twitter.Example.Activity",//source name
            "adapter": BC.Utils.SourceAdapters.createREST(twitterAdapterTemplate, {"params": {"follower_ids": followers}}),// Fetch data for list of follower ids
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
                "FiveMinuteIntervalOfWeek": "a value in the range [1,500] representing a 5 minute interval of the analyzed 7 day period, where [day1 at 00:00 - day1 at 00:05] is represented by 1 and [day7 at 23:55 - day7 at 24:00] is represented by 500",
                "ActivitiesCount": "the activity level measured as the number of followers that were active during the associated FiveMinuteIntervalOfWeek",
                "ActiveFollowers": "the number of distinct followers that were active during the associated FiveMinuteIntervalOfWeek",
                "ActivitiesCountMax": "the maximum ActivitiesCount encountered during the analyzed 7 day period",
                "ActiveFollowersMax": "the maximum ActiveFollowers encountered during the analyzed 7 day period"
            },
            "filter": pastWeekFilter, // the filter for this source specifying that only the data for the past week should be consumed
            "rate": BC.Meta.Period.Day  // the input consumption rate specifying that all available data from the input source should be consumed once every day - can be BC.Meta.Period.Event for continuous consumption of records as they are generated or BC.Meta.Period.Once which is the default.
        });
    if (!stream || !stream.validate()) {
        throw "Followers activity stream in Twitter example feed cannot be accessed, reason: " + stream.validationErrorMsg;
    }
}

//
// build scanner
//
if (!stream.getScanner("myBestTimeToTweetTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the stream
	let twitterActivityScanner = stream.createScanner();
	twitterActivityScanner.addConstraint("constraint30min", // constraint name
		function(curSequence) {
			return  curSequence.records[curSequence.records.length-1].FiveMinuteIntervalOfWeek - curSequence.records[0].FiveMinuteIntervalOfWeek <= 6;
		},
		"30 minutes size sequences" // explanation
	);
	twitterActivityScanner.addConstraint("constraintGrowingActiveFollowerCountWithAtLeast3Records",
		function(curSequence) {
			for (let i = 1; i < curSequence.records.length; i++) {
				if (curSequence.records[i].ActiveFollowers <= curSequence.records[i - 1].ActiveFollowers)
					return false;
			}
			return  curSequence.records.length >= 3;
		},
		"sequence should have at least 3 five minute intervals with an increasing number of active followers"
	);
	twitterActivityScanner.addConstraint("constraintAtLeast1ActiveFollowerAbove75%Max",
		function(curSequence) {
			return curSequence.records.some(record => record.ActiveFollowers > 0.75 * record.ActiveFollowersMax);
		},
		"amount of active followers for at least one record is above 75% of maximum of the week"
	);
	twitterActivityScanner.addConstraint("constraintAtLeast1ActivityCountAbove75%Max",
		function(curSequence) {
			return curSequence.records.some(record => record.ActivitiesCount > 0.75 * record.ActivitiesCountMax);
		},
		"amount of activities for at least one record is above 75% of maximum of the week"
	);

	twitterActivityScanner.settings = {
		"schedule" : BC.Meta.Period.Day, // or BC.Meta.Period.Once which is the default
		"activation" : BC.Utils.ActionAdapters.createJSCallback(function(result) {
			alert("Found the best time to tweet: "+ result+"\nExplanation: "+result.explanation);
		}),
		"start" : "Thu May 02 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // when to start back-test
		"end" : "Thu May 09 2019 11:48:05 GMT+0300 (Israel Daylight Time)", // finish back-test after a week
	};
	if (!twitterActivityScanner.validate()) {
		throw "Scanner not configured properly, reason: "+twitterActivityScanner.validationErrorMsg;
	}

	twitterActivityScanner.save("myBestTimeToTweetTheory", true); // override if such exists
}

// run our scanner on stream
stream.scan("myBestTimeToTweetTheory");