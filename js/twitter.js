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
followers.forEach(follower => {
	let followerStream = bc.Datastore.getStream("Twitter.Example." + follower);
	if (!followerStream) {
		followerStream = bc.Datastore.defineStream(
			"Twitter.Example." + follower,//source name
			BC.Utils.SourceAdapters.createREST(twitterAdapterTemplate, {"params": {"user_id": follower}}),// Reuse adapter to fetch data for follower
			["user_id", "created_at"] // specify which fields of the records being fetched from the source should be used to make up the stream's output record (if omitted, all fields will be used)
		);
		if (!followerStream || !followerStream.validate()) {
			throw "Access to follower " + follower + "'s Twitter example feed does not work, reason: " + followerStream.validationErrorMsg;
		}
	}
	inputSources[follower] = {
		"source": followerStream, // the actual source
		"filter": pastWeekFilter  // the filter for this source specifying that only the data for the past week should be consumed
	};
});

let view = bc.Datastore.createView(
	{
		"inputSources": inputSources, // the sources of records inputted to the view
		"rate": BC.Meta.Period.Day,  // the input consumption rate specifying that all available data from all the input sources should be consumed once every day (or BC.Meta.Period.Once which is the default)
	}, // the input to the view, in this case a data source (can also be another view)
	{
		"outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attribute and the value is that attribute's description
			"FiveMinuteIntervalOfWeek": "a value in the range [1,500] representing a 5 minute interval of the analyzed 7 day period, where [day1 at 00:00 - day1 at 00:05] is represented by 1 and [day7 at 23:55 - day7 at 24:00] is represented by 500",
			"ActivitiesCount": "the activity level measured as the number of followers that were active during the associated FiveMinuteIntervalOfWeek",
			"ActiveFollowers": "the number of distinct followers that were active during the associated FiveMinuteIntervalOfWeek",
			"ActivitiesCountMax": "the maximum ActivitiesCount encountered during the analyzed 7 day period",
			"ActiveFollowersMax": "the maximum ActiveFollowers encountered during the analyzed 7 day period"
		},
		"outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the view's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).
			let fiveMinIntervals = {};
			let activitiesCountMax = 0;
			let activeFollowersMax = 0;
			followers.forEach(follower => {
				inputRecordQueues[follower].forEach(record => {
					let interval = BC.Meta.Period.fiveMinIntervalOfWeek(record.created_at,today);// calculate the five minute interval of the week ending today which contains record.created_at
					if(!fiveMinIntervals[interval]){
						fiveMinIntervals[interval]={"ActiveFollowers":0,"ActivitiesCount":0};
					}
					if (!fiveMinIntervals[interval][record.user_id]) {
						fiveMinIntervals[interval][record.user_id] = 0;
						fiveMinIntervals[interval]["ActiveFollowers"]++;
						if (fiveMinIntervals[interval]["ActiveFollowers"] > activeFollowersMax) {
							activeFollowersMax = fiveMinIntervals[interval]["ActiveFollowers"];
						}
					}
					fiveMinIntervals[interval][record.user_id]++;
					fiveMinIntervals[interval]["ActivitiesCount"]++;
					if (fiveMinIntervals[interval]["ActivitiesCount"] > activitiesCountMax) {
						activitiesCountMax = fiveMinIntervals[interval]["ActivitiesCount"];
					}
				})
			});
			let outputRecordsQueue = [];
			for(let interval = 1; interval<=500; interval++){ // add output records in ascending 5 min interval of the week order
				if(fiveMinIntervals[interval]) { // verify that data exists for this interval
					outputRecordsQueue[outputRecordsQueue.length] = {
						"FiveMinuteIntervalOfWeek": interval,
						"ActivitiesCount": fiveMinIntervals[interval].ActivitiesCount,
						"ActiveFollowers": fiveMinIntervals[interval].ActiveFollowers,
						"ActivitiesCountMax": fiveMinIntervals[interval].ActivitiesCountMax,
						"ActiveFollowersMax": fiveMinIntervals[interval].ActiveFollowersMax
					};
				}
			}
			return outputRecordsQueue;
		}
	}
);


if (!view.validate()) {
	throw "View does not work, reason: "+view.validationErrorMsg;
}

view.save("Twitter.Example.followersView", true); // second parameter is whether to override an existing view

//
// build scanner
//
if (!view.getScanner("myBestTimeToTweetTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the view
	let twitterActivityScanner = view.createScanner();
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

// run our scanner on view
view.scan("myBestTimeToTweetTheory");