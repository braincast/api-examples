Examples = {
    OpenAPI: {
        JSON: {
            Alphavantage:{
                Intraday:{
                    "swagger": "2.0",
                    "info": {
                        "version": "1.0.0",
                        "title": "Stock Time Series"
                    },
                    "host": "www.alphavantage.co",
                    "schemes": [
                        "https"
                    ],
                    "paths": {
                        "/query": {
                            "get": {
                                "parameters": [
                                    {
                                        "in": "query",
                                        "name": "function",
                                        "type": "string",
                                        "required": true
                                    },
                                    {
                                        "in": "query",
                                        "name": "symbol",
                                        "type": "string",
                                        "required": true
                                    },
                                    {
                                        "in": "query",
                                        "name": "interval",
                                        "type": "string",
                                        "required": true
                                    },
                                    {
                                        "in": "query",
                                        "name": "apikey",
                                        "type": "string",
                                        "required": true
                                    }
                                ],
                                "produces": [
                                    "application/json"
                                ],
                                "responses": {
                                    "200": {
                                        "description": "Time series data per interval.",
                                        "schema": {
                                            "type": "array",
                                            "items": {
                                                "$ref": "#/definitions/Response"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "definitions": {
                        "Response": {
                            "type": "object",
                            "required": [
                                "MetaData"
                            ],
                            "properties": {
                                "Meta Data": {
                                    "$ref": "#/definitions/MetaData"
                                },
                                "TimeSeries": {
                                    "$ref": "#/definitions/TimeSeries"
                                }
                            }
                        },
                        "MetaData": {
                            "type": "object",
                            "properties": {
                                "1. Information": {
                                    "type": "string"
                                },
                                "2. Symbol": {
                                    "type": "string"
                                },
                                "3. Last Refreshed": {
                                    "type": "string"
                                },
                                "4. Interval": {
                                    "type": "string"
                                },
                                "5. Output Size": {
                                    "type": "string"
                                },
                                "6. Time Zone": {
                                    "type": "string"
                                }
                            }
                        },
                        "TimeSeries": {
                            "type": "array",
                            "items": {
                                "$ref": "#/definitions/EquityData",
                                "1. Information": {
                                    "type": "string"
                                },
                                "2. Symbol": {
                                    "type": "string"
                                },
                                "3. Last Refreshed": {
                                    "type": "string"
                                },
                                "4. Interval": {
                                    "type": "string"
                                },
                                "5. Output Size": {
                                    "type": "string"
                                },
                                "6. Time Zone": {
                                    "type": "object"
                                }
                            }
                        },
                        "EquityData": {
                            "type": "object",
                            "properties": {
                                "1. open": {
                                    "type": "string"
                                },
                                "2. high": {
                                    "type": "string"
                                },
                                "3. low": {
                                    "type": "string"
                                },
                                "4. close": {
                                    "type": "string"
                                },
                                "5. volume": {
                                    "type": "string"
                                }
                            }
                        }
                    }
                }
            },
            ProteinDataBank: {/*TODO*/},
            Twitter: {/*TODO*/},
            Churn: {/*TODO*/},
            NBA: {/*TODO*/}
        }
    },
    Adapters:{
        WeatherOpenAPITemplate:{/*TODO*/},
        HotelsAPITemplate:{/*TODO*/},
        FlightsOpenAPITemplate:{/*TODO*/},
        SkiAPI:{/*TODO*/},
        CalendarAPITemplate:{/*TODO*/},
    }
};
