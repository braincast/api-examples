const token = "my_braincast_token";
const secretKey = "my_secret_api_key";
const bc = BC.createClient(token, secretKey);
// A list of PDB ids for the proteins that represent the 10 different influenza NA subtypes:
const proteinFamilyFromUserRequest = ["3B7E","2AEP","4HZV","2HTV","3SAL","4QN4","4QN3","4WA3","4MWJ","4GDJ"];

//
// define and validate data sources
//
let stream = bc.Datastore.getStream("Influenza.Example.proteinDataset");
if (!stream) {
    stream = bc.Datastore.defineStream(
        "Influenza.Example.proteinDataset",//source name
        BC.Utils.SourceAdapters.createS3Adapter( // adapter for fetching a CSV file containing amino acid (AA) sequence and 3D info for many NA proteins, from AWS S3
            "AWS AKIAIOSFODNN7EXAMPLE:bWq2s1WEIj+Ydj0vQ697zp+IXMU=", //authorization string
            "proteins", // S3 bucket
            "NA.csv", // S3 object
            "CSV" // object type
        ),
        ["PdbID","Chain","AAPosition","AAName","XCoord","YCoord","ZCoord"] //fields from source to use in stream's output records
    );
    if (!stream || !stream.validate()) {
        throw "Cannot access data source, reason: "+stream.validationErrorMsg;
    }
}

//
// build view
//
let view = bc.Datastore.getView("Influenza.Example.proteinsView"); //This allows us to reuse a previously saved view. Note however, that if we want to change the content of proteinFamilyFromUserRequest, e.g. per user request, we will need to create a new view
if (!view) {
    //Create a view that outputs all amino acid records for the specified set of proteins in the order of the proteins' sequences:
    view = bc.Datastore.createView(
        {
            "inputSources": {// the sources of records inputted to the view (in other cases some of the input sources can be another view instead of a data source)
                "proteins": {
                    "source": stream,
                    "filter": {"where":"PdbID IN ("+proteinFamilyFromUserRequest.join(',')+") AND Chain = 'A'"}, // the filter for this source specifying that only the data for proteins in the specified set should be consumed
                    "order":["AAPosition"] // output ordering - order the amino acid records according to their order within their associated protein's sequence
                }
            } // the input source will only be consumed once since this is the default when no consumption rate is specified
        },
        {
            "outputRecordHeader": { // the structure of the output record where each property is the name of one of the record's attribute and the value is that attribute's description
                "PdbID":"the identifier of the protein that the amino acid represented by this record is associated with",
                "AAPosition":"the position of the amino acid within its associated protein",
                "AAName":"the name of the amino acid",
                "XCent":"the x-coordinate of the the amino acid's centroid atom",
                "YCent":"the y-coordinate of the the amino acid's centroid atom",
                "ZCent":"the z-coordinate of the the amino acid's centroid atom"
            },
            "outputRecordGenerator": function (inputRecordQueues) { // a function that specifies how data coming from the input sources is used to generate the view's output records whose structure must correspond to outputRecordHeader. This function will be invoked by the system after each input consumption step. inputRecordQueues is a set of queues, each holding the latest batch of consumed input data records for a specific input source (corresponding to that source's specified filter and in the order of consumption).
                let proteins = {};
                inputRecordQueues["proteins"].forEach(record => {
                    if (!proteins[record["PdbID"]]) {
                        proteins[record["PdbID"]] = {};
                    }
                    if (!proteins[record["PdbID"]][record["Chain"]]) {
                        proteins[record["PdbID"]][record["Chain"]] = {};
                    }
                    if(!proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]]){
                        proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]]={"numOfAtoms":0,"XCent":0,"YCent":0,"ZCent":0};
                    }
                    proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]].numOfAtoms++;
                    proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]].XCent+=record["XCoord"];
                    proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]].YCent+=record["YCoord"];
                    proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]].ZCent+=record["ZCoord"];
                });
                let outputRecordsQueue = [];
                inputRecordQueues["proteins"].forEach(record => {
                    let aminoAcidAtomsData = proteins[record["PdbID"]][record["Chain"]][record["AAPosition"]];
                    outputRecordsQueue[outputRecordsQueue.length] = {
                        "PdbID": record["PdbID"],
                        "AAPosition": record["AAPosition"],
                        "AAName": record["AAName"],
                        "XCent": aminoAcidAtomsData.XCent/aminoAcidAtomsData.numOfAtoms,
                        "YCent": aminoAcidAtomsData.YCent/aminoAcidAtomsData.numOfAtoms,
                        "ZCent": aminoAcidAtomsData.ZCent/aminoAcidAtomsData.numOfAtoms
                    };
                });
                return outputRecordsQueue;
            }
        }
    );

    if (!view.validate()) {
        throw "View does not work, reason: "+view.validationErrorMsg;
    }
    view.save("Influenza.Example.proteinsView", false); // second parameter is whether to override an existing view
}

//
// build scanner
//
if (!view.getScanner("myFunctionalSiteDetectionTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the view
    let scanner = view.createScanner();
    scanner.addConstraint("constraintAminoAcidTriads", // constraint name
        function(curSequence) {
            return  curSequence.records.length === 3 &&
                    curSequence.records.every(record => record.PdbID === curSequence.records[0].PdbID);
        },
        "must be a sequence of three amino acids (triads) within a protein" // explanation
    );
    scanner.addConstraint("constraintFunctionalSiteDiameter",
        function(curSequence) {
            for (let i = 0; i < curSequence.records.length; i++) {
                for (let j = i + 1; i < curSequence.records.length; i++) {
                    let aa1 = curSequence.records[i];
                    let aa2 = curSequence.records[j];
                    // Calculate the 3D distance between the current two AA in this sequence:
                    let distance = Math.sqrt(
                        Math.pow(aa2.XCent-aa1.XCent,2)+
                        Math.pow(aa2.YCent-aa1.YCent,2)+
                        Math.pow(aa2.ZCent-aa1.ZCent,2));
                    if (distance > 4e-10) {
                        return false;
                    }
                }
            }
            return true;
        },
        "all amino acids must be within a 4 angstrom spatial diameter"
    );
    scanner.addConstraint("constraintMinimumSupport",
        function(curSequence) {
            // Partition view into record sequences, one for each unique PdbID, i.e. one for each protein:
            let proteins = BC.Meta.Functions.Views.createPartition(
                view, // view associated with the scanner
                ["PdbID"] // the attributes by which to partition the view (i.e. all records with the same PdbID will be assigned to the same sequence).
            );
            // Use the support function to count the number of protein sequences whose AAName subsequences contain the current sequence's AAName subsequence (at least once):
            return BC.Meta.Functions.Sequences.support(
                curSequence,
                proteins,
                ["AAName"] // the attributes to consider when checking for containment
            ) >= 0.9 * proteins.length;
        },
        "should occur in at least 90% of the proteins"
    );

    if (!scanner.validate()) {
        throw "Scanner not configured properly, reason: "+scanner.validationErrorMsg;
    }

    scanner.save("myFunctionalSiteDetectionTheory", true); // override if such exists
}

// run our scanner on the view
result = view.scan("myFunctionalSiteDetectionTheory");
alert("Found the following functional site in NA family: "+ result+"\nExplanation: "+result.explanation);
