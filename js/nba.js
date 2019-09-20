const bcToken = "my_braincast_token";
const bcSecretKey = "my_secret_api_key";
const bc = BC.createClient(bcToken, bcSecretKey);
// assume the following four variables represent values specified by the user of your application:
const minYearFromUser = 1990;
const maxYearFromUser = 2019;
const positionFromUser = "center";
const teamFromUser = "Lakers";

const BasketballReferenceOpenAPITemplate = {
	openAPISpec: Examples.OpenAPI.JSON.NBA, // the Open API Specification (OAS) of a REST data source for accessing the churn user data
	path:"/query",  // the HTTP endpoint to use from the OAS spec
	operation:"get",  // the HTTP method to use
	params:{     // required values for parameters specified in the OAS
		"apikey":     "AKIAIOSFODNNSLOE:Yxg83MZaEgh3OZ3l0rLo5RTX11o="
	}
};

//
// define and validate data sources
//
let stream = bc.Datastore.getStream("NBA.Example.Seasons");
if (!stream) {
	stream = bc.Datastore.defineStream(
		{
			"source": "NBA.Example.Seasons",//source name
			"adapter": BC.Utils.SourceAdapters.createREST(BasketballReferenceOpenAPITemplate),// REST adapter to fetch data created from the data source's Open API Specification
			"record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
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
			"filter": {"where":"Year >= 1985"} // the filter for this source specifying that only the data after 1985 should be consumed
		}
	);
	if (!stream || !stream.validate()) {
		throw "Example stream cannot be accessed, reason: " + stream.validationErrorMsg;
	}
}

//
// build scanner
//
if (!stream.getScanner("myBestNBAPlayerTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the stream
	let scanner = stream.createScanner(
		{// make user specified values available for the scanner as scanner variables that can be accessed via the vars keyword (don't forget to update their values every time you scan the stream, e.g. for different user queries)
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

// run our scanner on the stream
result = stream.scan("myBestNBAPlayerTheory");
userRequirements = toUserRequestString(minYearFromUser,maxYearFromUser,positionFromUser,teamFromUser);
alert("The best NBA player matching your requirements ("+userRequirements+") is "+result+ ".");

//
// helper functions:
//
function toUserRequestString(minYearFromUser,maxYearFromUser,positionFromUser,teamFromUser) {
	return	minYearFromUser?`Year >= ${minYearFromUser} `:""+
	maxYearFromUser?`Year <= ${maxYearFromUser} `:""+
	positionFromUser?`Position = ${positionFromUser} `:""+
	teamFromUser?`Team = ${teamFromUser}`:"";
}
