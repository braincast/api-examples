const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);
// assume the following four variables represent values specified by the user of your application:
const minYearFromUser = 1990;
const maxYearFromUser = 2019;
const positionFromUser = "center";
const teamFromUser = "Lakers";

//
// define and validate data sources
//
let stream = bc.Datastore.getStream("NBA.Example.Seasons");
if (!stream) {
	stream = bc.Datastore.defineStream(
		"NBA.Example.Seasons",//source name
		BC.Utils.SourceAdapters.createREST(Examples.Adapters.BasketballReferenceOpenAPITemplate),// REST adapter to fetch data created from the data source's Open API Specification
		["Year","Player","Pos","Tm","G","GS","WS","MP","PER","BPM"] //fields from source to use in stream's output records
	);
	if (!stream || !stream.validate()) {
		throw "Cannot access data source, reason: "+stream.validationErrorMsg;
	}
}

//
// build view
//
let view = bc.Datastore.getView("NBA.Example.nbaView");
if (!view) {
	//Create a view that outputs any new seasonal data from 1980, every year:
	view = bc.Datastore.createView(
		{
			"inputSources": {// the sources of records inputted to the view (in other cases some of the input sources can be another view instead of a data source)
				"playersSeasons": {
					"source": stream,
					"filter": {"where":"Year >= 1985"} // the filter for this source specifying that only the data for seasons after 1980 should be consumed
				}
			} // the input source will only be consumed once since this is the default when no consumption rate is specified
		},
		{
			"outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attribute and the value is that attribute's description
				"Year":		     	"the season",
				"Player":	     	"player's full name",
				"Pos":		     	"player's position",
				"Tm":		     	"team's three letter name",
				"G":		     	"the number of games the player participated in",
				"GS":		     	"the number of games the player started in",
				"WS":		     	"the player's Wins Shares score",
				"MP":		     	"the amount of minutes played by the player",
				"PER":		     	"the player's Player Efficiency Rating score",
				"BPM":		     	"the player's Box +/- score",
				"rankTeamMP":    	"the player's minutes played (MP) ranking compared to other players in his team and for same year",
				"percentileYearWS": "the player's wins share (WS) percentile compared to other players in the league for the same year"
			},
			"outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the view's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).
				let years = {};
				inputRecordQueues["playersSeasons"].forEach(record => {
					let curYear = record["Year"];
					if (!years[curYear]) {
						years[curYear] = {"allPlayersWS": [], "teamSpecificMP": {}};
					}
					insertSorted(record["WS"],years[curYear]["allPlayersWS"]);
					let curTeam = record["Tm"];
					if (!years[curYear]["teamSpecificMP"][curTeam]) {
						years[curYear]["teamSpecificMP"][curTeam] = [];
					}
					insertSorted(record["MP"],years[curYear]["teamSpecificMP"][curTeam]);
				});
				let outputRecordsQueue = [];
				inputRecordQueues["playersSeasons"].forEach(record => {
					let year = record["Year"];
					let ws = record["WS"];
					let team = record["Tm"];
					let mp = record["MP"];
					outputRecordsQueue[outputRecordsQueue.length] = {
						"Year": year,
						"Player": record["Player"],
						"Pos": record["Pos"],
						"Tm": team,
						"G": record["G"],
						"GS": record["GS"],
						"WS": ws,
						"MP": mp,
						"PER": record["PER"],
						"BPM": record["BPM"],
						"rankTeamMP": rank(mp, years[year]["teamSpecificMP"][team]),
						"percentileYearWS": percentile(ws, years[year]["allPlayersWS"])
					};
				});
				return outputRecordsQueue;
			}
		}
	);

	if (!view.validate()) {
		throw "View does not work, reason: "+view.validationErrorMsg;
	}

	view.save("NBA.Example.nbaView", false); // second parameter is whether to override an existing view
}

//
// build scanner
//
if (!view.getScanner("myBestNBAPlayerTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the view
	let scanner = view.createScanner(
		{// make user specified values available for the scanner as scanner variables that can be accessed via the vars keyword (don't forget to update their values every time you scan the view, e.g. for different user queries)
			"minYearFromUser": undefined,
			"maxYearFromUser": undefined,
			"positionFromUser": undefined,
			"teamFromUser": undefined
		}
	);
	scanner.addConstraint("consecutiveSeasons", // constraint name
		function(curSequence) {
			for (let i = 1; i < curSequence.records.length; i++) {
				if (curSequence.records[i].Year - curSequence.records[i-1].Year !== 1) {
					return false;
				}
			}
			return true;
		},
		"seasons are consecutive"// explanation
	);
	scanner.addConstraint("3Seasons",
		function(curSequence) {
			return  curSequence.records.length === 3;
		},
		"there are exactly 3 seasons"// explanation
	);
	scanner.addConstraint("samePlayer",
		function(curSequence) {
			return  curSequence.records.every(record => record.Player === curSequence.records[0].Player);
		},
		""
	);
	scanner.addConstraint("sameTeam",
		function(curSequence) {
			return  curSequence.records.every(record => record.Tm === curSequence.records[0].Tm);
		},
		"the player played for the same team in every season"
	);
	scanner.addConstraint("rankedTop5",
		function(curSequence) {
			let lastSeason = curSequence.records[curSequence.records.length-1];
			return  lastSeason.rankTeamMP <= 5;
		},
		"the player was ranked among the top 5 players in his team who played the most minutes (MP) during the last season"
	);
	scanner.addConstraint("startedInOver80%",
		function(curSequence) {
			let lastSeason = curSequence.records[curSequence.records.length-1];
			return  lastSeason.GS / lastSeason.G > 0.8;
		},
		"the player started in more than 80% of the games he played (GS/G) during the last season"
	);
	scanner.addConstraint("winSharesAboveMedian",
		function(curSequence) {
			return  curSequence.records[curSequence.records.length-1].percentileYearWS > 50;
		},
		"the player's win shares (WS) score in the last season was above the median of all players in the league"
	);
	scanner.addConstraint("everyPER>18",
		function(curSequence) {
			return 	curSequence.records.every(record => record.PER > 18) ;
		},
		"the player's efficiency rating (PER) was above 18 in every season"
	);
	scanner.addConstraint("lastPER>20",
		function(curSequence) {
			return 	curSequence.records[curSequence.records.length-1].PER > 20;
		},
		"the player's efficiency rating (PER) was above 20 in the last season"
	);
	scanner.addConstraint("everyBPM>1",
		function (curSequence) {
			return curSequence.records.every(record => record.BPM > 1);
		},
		"the player's contribution to the team, measured by box +/- (BPM), was 1 point above the league-average (for which BPM = 0)"
	);
	scanner.addConstraint("nonDecreasingBPM",
		function (curSequence) {
			for (let i = 1; i < curSequence.records.length; i++) {
				if (curSequence.records[i].BPM < curSequence.records[i-1].BPM) {
					return false;
				}
			}
			return true;
		},
		"the player's contribution to the team, measured by box +/- (BPM), didn't decrease from one season to the next"
	);
	function bpmAvg(pattern) {
		return pattern.records.reduce(function (sum, record) {
			return sum + record["BPM"];
		}, 0) / (pattern.records.length || 1);
	}
	scanner.addConstraint(
		BC.Meta.Functions.Constraints.newMaximalValueConstraint(
			"highestBPMAvg",
			bpmAvg, // evaluator function - the sequence for which this function's value is maximal will be selected out of all sequences satisfying all other constraints
			"having the greatest contribution to the team, measured by the average box +/- (BPM) over all seasons"
	));
	scanner.addConstraint("constraintUserInput",
		function (curSequence) {
			let lastSeason = curSequence.records[curSequence.records.length-1];
			return 	((vars.minYearFromUser || lastSeason.Year >= vars.minYearFromUser) &&
					 (vars.maxYearFromUser || lastSeason.Year <= vars.maxYearFromUser) &&
					 (vars.positionFromUser || lastSeason.Position === vars.positionFromUser) &&
					 (vars.teamFromUser || lastSeason.Team === vars.teamFromUser));
		},
	"satisfy the user's request parameters: "+toUserRequestString(vars.minYearFromUser,vars.maxYearFromUser,vars.positionFromUser,vars.teamFromUser)
	);

	if (!scanner.validate()) {
		throw "Scanner not configured properly, reason: "+scanner.validationErrorMsg;
	}

	scanner.save("myBestNBAPlayerTheory", true); // override if such exists
}

// Update the user specified values available to the scanner (in case the scanner was fetched from backend):
scanner.vars = {
	"minYearFromUser": minYearFromUser,
	"maxYearFromUser": maxYearFromUser,
	"positionFromUser": positionFromUser,
	"teamFromUser": teamFromUser
};

// run our scanner on the view
result = view.scan("myBestNBAPlayerTheory");
userRequirements = toUserRequestString(minYearFromUser,maxYearFromUser,positionFromUser,teamFromUser);
alert("The best NBA player matching your requirements ("+userRequirements+") is "+result+ ".");

//
// helper functions:
//
function percentile(val, sortedArray) {
	if(val<sortedArray[0]) return 0;
	if(val>sortedArray[sortedArray.length-1]) return 100;
	for (let i = 0; i < sortedArray.length-1; i++) {
		if(val >= sortedArray[i] && val < sortedArray[i+1]) return 100 * (i+1)/sortedArray.length;
	}
}
function rank(val, sortedArray) {
	if(val<=sortedArray[0]) return sortedArray.length;
	if(val>=sortedArray[sortedArray.length-1]) return 1;
	for (let i = sortedArray.length-2; i > 0; i--) {
		if(val >= sortedArray[i] && val < sortedArray[i+1]) return sortedArray.length-i;
	}
}
function insertSorted(val, array) {
	array.push(val);
	array.sort(function (a, b) { return a-b; });
}
function toUserRequestString(minYearFromUser,maxYearFromUser,positionFromUser,teamFromUser) {
	return	minYearFromUser?`Year >= ${minYearFromUser} `:""+
	maxYearFromUser?`Year <= ${maxYearFromUser} `:""+
	positionFromUser?`Position = ${positionFromUser} `:""+
	teamFromUser?`Team = ${teamFromUser}`:"";
}
