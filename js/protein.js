const token = "my_braincast_token";
const secretKey = "my_secret_api_key";
const bc = BC.createClient(token, secretKey);
// A list of PDB ids for the proteins that represent the 10 different influenza NA subtypes:
const proteinFamilyFromUserRequest = ["3B7E", "2AEP", "4HZV", "2HTV", "3SAL", "4QN4", "4QN3", "4WA3", "4MWJ", "4GDJ"];

//
// define and validate data sources
//
let stream = bc.Datastore.getStream("Influenza.Example.proteinDataset");
if (!stream) {
    stream = bc.Datastore.defineStream(
        {
            "source": "Influenza.Example.proteinDataset",//source name
            "adapter": BC.Utils.SourceAdapters.createS3Adapter( // adapter for fetching a CSV file containing amino acid (AA) sequence and 3D info for many NA proteins, from AWS S3
                "AWS AKIAIOSFODNN7EXAMPLE:bWq2s1WEIj+Ydj0vQ697zp+IXMU=", //authorization string
                "proteins", // S3 bucket
                "NA.csv", // S3 object
                "CSV" // object type
            ),
            "record": { // provide an object to specify which attributes of the records being fetched from the source should be used (if omitted, all attributes will be used) - each property is an attribute and the value is that attribute's description:
                "PdbID": "the identifier of the protein that the amino acid represented by this record is associated with",
                "AAPosition": "the position of the amino acid within its associated protein",
                "AAName": "the name of the amino acid",
                "XCent": "the x-coordinate of the the amino acid's centroid atom",
                "YCent": "the y-coordinate of the the amino acid's centroid atom",
                "ZCent": "the z-coordinate of the the amino acid's centroid atom"
            },
            "filter": {"where": "PdbID IN (" + proteinFamilyFromUserRequest.join(',') + ") AND Chain = 'A'"}, // the filter for this source specifying that only the data for proteins in the specified set should be consumed
            "order": ["AAPosition"]// output ordering - order the amino acid records according to their order within their associated protein's sequence
        }
    );
    if (!stream || !stream.validate()) {
        throw "Cannot access data source, reason: " + stream.validationErrorMsg;
    }
}

//
// build scanner
//
if (!stream.getScanner("myFunctionalSiteDetectionTheory")) { // the name of the scanner and the patterns inside the scanner are in the namespace of the stream
    let scanner = stream.createScanner();
    scanner.addConstraint("constraintAminoAcidTriads", // constraint name
        function (curSequence) {
            return curSequence.records.length === 3 &&
                curSequence.records.every(record => record.PdbID === curSequence.records[0].PdbID);
        },
        "must be a sequence of three amino acids (triads) within a protein" // explanation
    );
    scanner.addConstraint("constraintFunctionalSiteDiameter",
        function (curSequence) {
            for (let i = 0; i < curSequence.records.length; i++) {
                for (let j = i + 1; i < curSequence.records.length; i++) {
                    let aa1 = curSequence.records[i];
                    let aa2 = curSequence.records[j];
                    // Calculate the 3D distance between the current two AA in this sequence:
                    let distance = Math.sqrt(
                        Math.pow(aa2.XCent - aa1.XCent, 2) +
                        Math.pow(aa2.YCent - aa1.YCent, 2) +
                        Math.pow(aa2.ZCent - aa1.ZCent, 2));
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
        function (curSequence) {
            // Partition stream into record sequences, one for each unique PdbID, i.e. one for each protein:
            let proteins = BC.Meta.Functions.Streams.createPartition(
                stream, // stream associated with the scanner
                ["PdbID"] // the attributes by which to partition the stream (i.e. all records with the same PdbID will be assigned to the same sequence).
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
        throw "Scanner not configured properly, reason: " + scanner.validationErrorMsg;
    }

    scanner.save("myFunctionalSiteDetectionTheory", true); // override if such exists
}

// run our scanner on the stream
result = stream.scan("myFunctionalSiteDetectionTheory");
alert("Found the following functional site in NA family: " + result + "\nExplanation: " + result.explanation);
