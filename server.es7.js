'use strict';

// ////////////////////////////////////////////////////////////////////////////
// CONSTANTS / CONFIG /////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

const navitia_token = '52b565cd-34fb-49b7-82e8-06ad3e63e736';

// ////////////////////////////////////////////////////////////////////////////
// DEPENDENCIES ///////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

// Encodes a string in base 64
function btoa (str) {return new Buffer(str).toString('base64');}

// Returns the average of two numbers
function middle(a,b) { return (a+b)/2 }

// Measures the distance in meters between two coordinates (latitude & longitude)
function measure(coord1, coord2) {
	var lat1 = coord1.lat;
	var lon1 = coord1.lon;
	var lat2 = coord2.lat;
	var lon2 = coord2.lon;
    var R = 6378.137; // Radius of earth in KM
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    var d = R * c;
    return d * 1000; // meters
}

// http://stackoverflow.com/questions/2855189/sort-latitude-and-longitude-coordinates-into-clockwise-ordered-quadrilateral

require('babel-polyfill');
var db_credentials = require('./db_credentials.js'),
	secrets = require('./secrets.js'),
	jwt = require('machinepack-jwt'),
	db = require('mysql2-promise')(),
	cors = require('cors'),
	request = require('request-promise'),
	express = require('express'),
	bodyParser = require('body-parser'),
	isNumeric = require("isnumeric"),
	create_debugger = require('debug'),
	debug = create_debugger('sencity'),
	debug_jwt = create_debugger('sencity:jwt'),
	sha1 = require('sha1');

const salt = secrets.salt,
	  jwt_secret = secrets.jwt_secret;

// ////////////////////////////////////////////////////////////////////////////
// DATABASE ///////////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

db.configure(db_credentials);

db.pool.on('connection', function (poolConnection) {
    poolConnection.config.namedPlaceholders = true;
});

// ////////////////////////////////////////////////////////////////////////////
// CLASSES ////////////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

// Sends requests to Navitia API
class NavitiaRequests {
	
	constructor(navitia_token) {
		this.navitia_token = navitia_token;
		this.http_headers = { 
			"Authorization": "Basic " + btoa(this.navitia_token + ":" + ""),
			"Accepts": "application/json"
		};
	}
	
	async request_address (coord) {
		if (!isNumeric(coord.lon) || !isNumeric(coord.lat)) throw new Error('Address - Coordinates aren\'t numeric.');
		var response = await request({
			uri: 'http://api.navitia.io/v1/coord/' + coord.lon + ';' + coord.lat,
			headers: this.http_headers,
			json: true
		});
		return {address: response.address.name};
	}
	
	async request_autocomplete (q) {
		return request({
			uri: 'http://api.navitia.io/v1/coverage/fr-idf/places?type[]=stop_point&type[]=address&type[]=poi&type[]=stop_area&q=' + encodeURIComponent(q),
			headers: this.http_headers,
			json: true
		});	
	}
	
	async request_routes (from,to) {
		if (!isNumeric(from.lon) || !isNumeric(from.lat) || !isNumeric(to.lon) || !isNumeric(to.lat)) throw new Error('Coordinates aren\'t numeric.');
		return request({
			uri: 'http://api.navitia.io/v1/journeys?from='+from.lon+';'+from.lat+'&to='+to.lon+';'+to.lat+'',
			headers: this.http_headers,
			json: true
		});	
	}
	
	async request_walking_section (from,to) {
		if (!isNumeric(from.lon) || !isNumeric(from.lat) || !isNumeric(to.lon) || !isNumeric(to.lat)) throw new Error('Walking section - Coordinates aren\'t numeric.');
		var walking_sections = await request({
			uri: 'http://api.navitia.io/v1/journeys?from='+from.lon+';'+from.lat+'&to='+to.lon+';'+to.lat+'&first_section_mode=walking& last_section_mode=walking',
			headers: this.http_headers,
			json: true
		});	
		if (walking_sections.journeys[0].sections.length > 1) {
			throw new Error('Walking section - Response has more than one section.');
		}
		return walking_sections.journeys[0].sections[0]; // Return the first (and only) section of the fastest journey
	}
	
	async request_preferably_walking_sections (from,to) {
		if (!isNumeric(from.lon) || !isNumeric(from.lat) || !isNumeric(to.lon) || !isNumeric(to.lat)) throw new Error('Walking section - Coordinates aren\'t numeric.');
		var walking_sections = await request({
			uri: 'http://api.navitia.io/v1/journeys?from='+from.lon+';'+from.lat+'&to='+to.lon+';'+to.lat+'&first_section_mode=walking& last_section_mode=walking',
			headers: this.http_headers,
			json: true
		});
		return walking_sections.journeys[0].sections;
	}
	
	async request_closest_poi (coord,max_distance) {
		if (!isNumeric(coord.lon) || !isNumeric(coord.lat) || !isNumeric(max_distance)) throw new Error('Closest poi - Coordinates aren\'t numeric.');
		
		// Note: the results are given in order of distance. Thus, the first POI of the response (if there is one) is always the closest one.
		var parks_response_and_gardens_response = await Promise.all([
			request({
				uri: 'http://api.navitia.io/v1/coverage/fr-idf/coords/' + coord.lon+';'+coord.lat + '/places_nearby?count=1&distance='+max_distance+'&type[]=poi&filter=poi_type.id=poi_type:leisure:park',
				headers: this.http_headers,
				json: true
			}),
			request({
				uri: 'http://api.navitia.io/v1/coverage/fr-idf/coords/' + coord.lon+';'+coord.lat + '/places_nearby?count=1&distance='+max_distance+'&type[]=poi&filter=poi_type.id=poi_type:leisure:garden',
				headers: this.http_headers,
				json: true
			})]);
		
		var [parks_response, gardens_response] = parks_response_and_gardens_response;
		
		if (typeof parks_response.places_nearby == 'undefined' && typeof gardens_response.places_nearby == 'undefined')
		{
			return []; // No POI nearby
		}
		else
		{
			var retained_poi;
			
			// Get the closest POI (either a park or a garden based on the shortest distance)
			if (typeof parks_response.places_nearby != 'undefined' &&
				(
				typeof gardens_response.places_nearby == 'undefined' ||
				parseFloat(parks_response.places_nearby[0].distance) < parseFloat(gardens_response.places_nearby[0].distance)
				) )
				retained_poi = parks_response.places_nearby[0];
			else
				retained_poi = gardens_response.places_nearby[0];
			
			return { name: retained_poi.poi.name, distance: retained_poi.distance, coord: retained_poi.poi.coord };
		}
	}
}

var nv = new NavitiaRequests(navitia_token);

// ////////////////////////////////////////////////////////////////////////////
// ROUTER /////////////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

var app = express();
app.use(cors()); // We allow CORS with a view to the mobile app porting
app.use(bodyParser.json()); // Add support for JSON-encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // Add support for URL-encoded bodies

// Middleware that requires authentication and gives the subsequent middleware access to the user's info with req.jwt
var authenticate_with_jwt =
	(req, res, next) => {
		debug_jwt('Authenticating request with JWT...');
		jwt.decode({
			secret: jwt_secret,
			token: req.headers.authorization.split(' ')[1], // @todo sanitize more
			schema: {
				id_user: 1,
				mail: 'mail@mail.fr',
				username: 'username'
			}
		}).exec({
			error: function(e) {
				console.error(e);
				res.sendStatus(401);
			},
			success: function (result) {
				debug_jwt('JWT authentication succeeded.', result);
				req.jwt = result;
				next();
			},
		});
	};

// ////////////////////////////////////////////////////////////////////////////
// ROUTES /////////////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

// {}
app.get('/', function(req, res) {
  res.send('This port is used to communicate with the Sencity API.');
});

// {username: 'jordanloftis', mail: 'jdloftis@yopmail.com', password: 'mypassword' }
app.post('/api/v1/sign_up', async (req, res) => {
	try {
		var [q] = await db.query('INSERT INTO users(username, mail, password) VALUES(:username, :mail, :password)',{username: req.body.username, mail: req.body.mail, password: sha1(req.body.password + salt)});
		jwt.encode({
			secret: jwt_secret,
			payload: {
				id_user: q.insertId,
				mail: req.body.mail,
				username: req.body.username
			}
		}).exec({
			success: function (result) {
				res.send({
					token: result
				});
			},
		});
	}
	catch (e) {
		console.error(e);
	}	
});

// {mail: 'jdloftis@yopmail.com', password: 'mypassword' }
app.post('/api/v1/sign_in', async (req, res) => {
	try {
		if (req.body.mail.length === 0) { res.sendStatus(401); return; }
		
		var [[user]] = await db.query('SELECT id, mail, username FROM users WHERE mail=:mail AND password=:password',{mail: req.body.mail, password: sha1(req.body.password + salt)});
		if (typeof user === 'undefined' || user.mail !== req.body.mail)
			res.sendStatus(401);
		else
		{
			jwt.encode({
				secret: jwt_secret,
				payload: {id_user: user.id, mail: user.mail, username: user.username}
			}).exec({
				success: function (result) {
					res.send({token: result});
				},
			});
		}
	}
	catch (e) {
		console.error(e);
	}	
});

// {}
app.get('/api/v1/profile', authenticate_with_jwt, async (req, res) => {
	try {
		res.send({username: req.jwt.username});
	}
	catch (e)
	{
		console.error(e);
	}
});

// {lon: 6.121, lat: 12.122}
app.get('/api/v1/address', async (req, res) => {
	try {
		var response = await nv.request_address({lon: req.query.lon, lat: req.query.lat});
		res.send(response);
	}
	catch (e) {
		console.error(e);
	}	
});

// {q: '66 avenu'}
app.get('/api/v1/autocomplete', async (req, res) => {
	try {
		var response = await nv.request_autocomplete(req.query.q);
		
		// We prune the overly verbose response of Navitia API
		var cleaned_up_places = response['places'].map(
			place => ({name: place.name,
					   coord: place[place.embedded_type].coord })
		);

		res.send(cleaned_up_places);
	}
	catch (e) {
		console.error(e);
	}	
});

// {lon: 12.109, lat: 3.412}
app.get('/api/v1/closest_poi', async (req, res) => {
	try {
		var response = await nv.request_closest_poi({lon: req.query.lon, lat: req.query.lat},150);
		res.send(response);
	}
	catch (e)
	{
		console.error(e);
	}
});

// {type: 0, name: X, lon: 12.12, lat: 42.42}
app.post('/api/v1/spot', authenticate_with_jwt, async (req, res) => {
	try {
		var [spots] = await db.query('INSERT INTO spots(name, type, lon, lat, added_by) VALUES(:name,:type,:lon,:lat,:added_by)',{name: req.body.name, type: req.body.type, lon: req.body.lon, lat: req.body.lat, added_by: req.jwt.id_user});
		res.send('OK');
	}
	catch (e)
	{
		console.error(e);
	}
});

// {}
app.get('/api/v1/spots', authenticate_with_jwt, async (req, res) => {
	try {
		var [spots] = await db.query('SELECT spots.*, IF(uvs.id_spot IS NULL,0,1) visited FROM spots LEFT JOIN user_visited_spots AS uvs ON uvs.id_spot = spots.id AND uvs.id_user = :id_user',{id_user: req.jwt.id_user});
		spots = spots.map(spot => ({
			id: spot.id,
			name: spot.name,
			type: spot.type,
			added_by: spot.added_by,
			visited: spot.visited,
			coord: {
				lon: spot.lon,
				lat: spot.lat
			}
		}));
		res.send(spots);
	}
	catch (e)
	{
		console.error(e);
	}
});

// {spots: [4,8,15,23,42]}
app.get('/api/v1/spots_route', async (req, res) => {
	try {
		var sections = [];
		var previous_lon, previous_lat;
		for (var i = 0; i<req.query.spots.length; i++)
		{
			var spot_id = req.query.spots[i];
			var [[spot]] = await db.query('SELECT * FROM spots WHERE id = :spot_id',{spot_id: spot_id});
			
			if (i>0)
				sections = sections.concat(await nv.request_preferably_walking_sections({lon: previous_lon, lat: previous_lat}, {lon:spot.lon, lat: spot.lat}));
			
			[previous_lon, previous_lat] = [spot.lon, spot.lat]
		}
		res.send(sections);
	}
	catch (e) 
	{
		console.error(e);	
	}
});

// {from_lon: 12.109, from_lat: 3.412, to_lon:12.108, to_lat: 3.412}
app.get('/api/v1/route', authenticate_with_jwt, async (req, res) => {
	
	try {
		var response = await nv.request_routes({lon: req.query.from_lon, lat: req.query.from_lat}, {lon: req.query.to_lon, lat: req.query.to_lat});
		
		var best_route = response.journeys[0];
		
		// We prune the excess information and reduce nesting.
		var cleaned_up_sections = best_route.sections.map(function (section) {
			var cleaned_up_section = {
				duration: section.duration,
				type: section.type
			};
			
			if (section.type != 'waiting')
			{
				// Add "from" coords, "to" coords, and geosjon to the cleaned up section
				Object.assign(cleaned_up_section,{
					from: {
						name: section.from.name,
						coord: section.from[section.from.embedded_type].coord
					},
					to: {
						name: section.to.name,
						coord: section.to[section.to.embedded_type].coord
					},
					geojson: section.geojson
				});
				
				// If the section is a train/metro section, add information about train/metro line number and direction (final train/metro station of the line)
				if (typeof section.display_informations !== 'undefined')
				{
					Object.assign(cleaned_up_section,{line: section.display_informations.label, direction: section.display_informations.direction});
				}
			}
			
			return cleaned_up_section;
		});
		
		// Work out more pleasant sections (add one detour through a park/garden max by walking section) based on the cleaned up sections
		
		var more_pleasant_sections = [];
		var more_pleasant_duration = 0;
		var more_pleasant_waypoints = []; // The POIs and spots that the route will go through
		
		for (var i = 0; i<cleaned_up_sections.length; i++)
		{
			let section = cleaned_up_sections[i];
			
			// If the section is a train/metro section, leave it untouched
			if (section.type != 'street_network')
			{
				more_pleasant_sections.push(section);
				more_pleasant_duration += section.duration;
			}
			else // Otherwise, try to make a detour through a nearby POI (garden/park) or spot
			{
				
				debug('Trying to find a detour for walking section...');
				
				// We first draw a circle that passes through the starting point and destination point, and whose center is the middle of the segment formed by those two points ; we then proceed to find the spot or else the Point of Interest (POI) within this circle that is closest to its center.
				
				var middle_point = {
					lon: middle(parseFloat(section.from.coord.lon),parseFloat(section.to.coord.lon)),
					lat: middle(parseFloat(section.from.coord.lat),parseFloat(section.to.coord.lat))
				};
				
				var max_distance_from_middle_point = parseInt(measure(section.from.coord,section.to.coord)/2);
				
				// Retrieve the spots in order of distance to the middle point, favouring spots that haven't yet been visited by the user
				var [spots] = await db.query(
					'SELECT ' +
					'	spots.*, ' +
					'	IF(uvs.id_spot IS NULL,0,1) visited, ' +
					'	( ' +
					'		3959 * acos ( ' +
					'		cos ( radians(:middle_point_lat) )' +
					'		* cos( radians( lat ) ) ' +
					'		* cos( radians( lon ) - radians(:middle_point_lon) )' +
					'		+ sin ( radians(:middle_point_lat) )' +
					'		* sin( radians( lat ) ) ' +
					'		) ' +
					'		* 1609.34' + // miles to meter conversion
					'	) AS distance ' +
					'FROM spots ' +
					'LEFT JOIN user_visited_spots AS uvs ON uvs.id_spot = spots.id AND uvs.id_user = :id_user ' +
					'HAVING distance < :max_distance_from_middle_point ' +
					'ORDER BY visited, distance ' +
					'LIMIT 1',
					{id_user: req.jwt.id_user,
					middle_point_lon: middle_point.lon,
					middle_point_lat: middle_point.lat,
					max_distance_from_middle_point: max_distance_from_middle_point});
				
				let closest_waypoint;
				if (spots.length > 0)
				{
					let closest_spot = spots[0];
					debug('Nearby spot found !',closest_spot);
					closest_waypoint = {	type: closest_spot.type,
											name: closest_spot.name,
											coord: {lon: closest_spot.lon,
													lat: closest_spot.lat}
										   };
				}
				else
				{
					debug('No nearby spot found. Falling back to finding a POI.');
					
					closest_waypoint = await nv.request_closest_poi(middle_point, max_distance_from_middle_point);
					
					if (Object.keys(closest_waypoint).length == 0) // If there's no POI within the circle, we leave the section untouched
					{
						debug('No nearby POI found. Leaving walking section untouched.');	
						more_pleasant_sections.push(section);
						more_pleasant_duration += section.duration;
						continue;
					}
					
					debug('Nearby POI found !',closest_waypoint);
				}
				
				debug('Adding closest waypoint to list of waypoints.',closest_waypoint);
				more_pleasant_waypoints.push(closest_waypoint);
				
				// We replace the original section with two sections, the first one going from the starting point to the POI, and the other one going from the POI to the destination point
				
				var sections_to_waypoint = await nv.request_preferably_walking_sections(section.from.coord,closest_waypoint.coord);
				debug('Route (A) to the waypoint has %s section(s) (ideally only one)',sections_to_waypoint.length);
				
				var sections_from_waypoint = await nv.request_preferably_walking_sections(closest_waypoint.coord,section.to.coord);
				debug('Route (B) from the waypoint has %s section(s) (ideally only one)',sections_to_waypoint.length); 
				
				more_pleasant_sections = more_pleasant_sections.concat(sections_to_waypoint).concat(sections_from_waypoint);
				more_pleasant_duration += sections_to_waypoint.concat(sections_from_waypoint).reduce((duration_so_far, section) => duration_so_far + section.duration, 0);
				
				debug('The original walking section has been replaced with two sections going to and from the newly found waypoint.');
			}
		}
		
		debug('Sending the final route to the client.');
		
		res.send({
			duration: more_pleasant_duration,
			sections: more_pleasant_sections,
			waypoints: more_pleasant_waypoints
		});
	}
	catch (e) {
		console.log(e);
	} 
	
});

// ////////////////////////////////////////////////////////////////////////////
// SERVER STARTUP /////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////////////////////

var server = app.listen(3000, 'localhost', () => {
  var host = server.address().address;
  var port = server.address().port;

  debug('Listening at http://%s:%s', host, port);
});