/*
 * Had to rework original tilemap functionallity to migrate 
 * to TemplateVisType. Combined pieces from 
 *   plugins/kbn_vislib_vis_types/public/tileMap.js
 *   ui/public/vislib/visualizations/tile_map.js
 */
import d3 from 'd3';
import _ from 'lodash';
import $ from 'jquery';
import AggResponseGeoJsonGeoJsonProvider from 'ui/agg_response/geo_json/geo_json';
import MapProvider from 'plugins/enhanced_tilemap/vislib/_map';

define(function (require) {
  var module = require('ui/modules').get('kibana/enhanced_tilemap', ['kibana']);
  
  module.controller('KbnEnhancedTilemapVisController', function ($scope, $rootScope, $element, Private, courier, config, getAppState) {
    let aggResponse = Private(require('ui/agg_response/index'));
    const queryFilter = Private(require('ui/filter_bar/query_filter'));
    let TileMapMap = Private(MapProvider);
    const geoJsonConverter = Private(AggResponseGeoJsonGeoJsonProvider);
    let map = null;

    //Useful bits of ui/public/vislib_vis_type/buildChartData.js
    function buildChartData(resp) {
      var tableGroup = aggResponse.tabify($scope.vis, resp, {
        canSplit: true,
        asAggConfigResults: true
      });
      var tables = tableGroup.tables;
      var firstChild = tables[0];
      return geoJsonConverter($scope.vis, firstChild);
    }

    function getGeoExtents(visData) {
      return {
        min: visData.geoJson.properties.min,
        max: visData.geoJson.properties.max
      }
    }

    $scope.$watch('esResponse', function (resp) {
      if(resp) {
        const chartData = buildChartData(resp);
        const geoMinMax = getGeoExtents(chartData);
        chartData.geoJson.properties.allmin = geoMinMax.min;
        chartData.geoJson.properties.allmax = geoMinMax.max;
        if (map === null) {
          appendMap({
            center: _.get(chartData, 'geoJson.properties.center'),
            zoom: _.get(chartData, 'geoJson.properties.zoom'),
            valueFormatter: _.get(chartData, 'valueFormatter')
          });
        }
        if (_.has(chartData, 'geohashGridAgg')) {
          const agg = _.get(chartData, 'geohashGridAgg');
          map.addFilters(getGeoFilters(agg.fieldName()));
        }
        if (_.get($scope.vis.params, 'overlay.wms.enabled')) {
          addWmsOverlays();
        }
        map.addMarkers(chartData, $scope.vis.params);
      }
    });

    var changeVisOff = $rootScope.$on(
      'change:vis', 
      _.debounce(resizeArea, 200, false));
    
    $scope.$on("$destroy", function() {
      if (map) map.destroy();
      changeVisOff();
    });

    function getGeoFilters(field) {
      let filters = [];
      _.flatten([queryFilter.getAppFilters(), queryFilter.getGlobalFilters()]).forEach(function (it) {
        if (isGeoFilter(it, field) && !_.get(it, 'meta.disabled', false)) {
          const features = filterToGeoJson(it, field);
          filters = filters.concat(features);
        }
      });
      return filters;
    }

    function addWmsOverlays() {
      const url = _.get($scope.vis.params, 'overlay.wms.url');
      const name = _.get($scope.vis.params, 'overlay.wms.options.displayName', 'WMS Overlay');
      const options = {
        format: 'image/png',
        layers: _.get($scope.vis.params, 'overlay.wms.options.layers'),
        transparent: true,
        version: '1.1.1'
      };
      if (_.get($scope.vis.params, 'overlay.wms.options.viewparams.enabled')) {
        const source = new courier.SearchSource();
        const appState = getAppState();
        source.set('filter', queryFilter.getFilters());
        if (appState.query && !appState.linked) {
          source.set('query', appState.query);
        }
        source._flatten().then(function (fetchParams) {
          const esQuery = fetchParams.body.query;
          //remove kibana parts of query
          const cleanedMust = [];
          if (_.has(esQuery, 'filtered.filter.bool.must')) {
            esQuery.filtered.filter.bool.must.forEach(function(must) {
              cleanedMust.push(_.omit(must, ['$state', '$$hashKey']));
            });
          }
          esQuery.filtered.filter.bool.must = cleanedMust;
          const cleanedMustNot = [];
          if (_.has(esQuery, 'filtered.filter.bool.must_not')) {
            esQuery.filtered.filter.bool.must_not.forEach(function(mustNot) {
              cleanedMustNot.push(_.omit(mustNot, ['$state', '$$hashKey']));
            });
          }
          esQuery.filtered.filter.bool.must_not = cleanedMustNot;
          
          options.viewparams = 'q:' + JSON.stringify(esQuery).replace(new RegExp('[,]', 'g'), '\\,');
          map.addWmsOverlay(url, name, options);
        });
      } else {
        map.addWmsOverlay(url, name, options);
      }
    }

    function filterToGeoJson(filter, field) {
      let features = [];
      if (_.has(filter, 'or')) {
        _.get(filter, 'or', []).forEach(function(it) {
          features = features.concat(filterToGeoJson(it, field));
        });
      } else if (_.has(filter, 'geo_bounding_box.' + field)) {
        const topLeft = _.get(filter, 'geo_bounding_box.' + field + '.top_left');
        const bottomRight = _.get(filter, 'geo_bounding_box.' + field + '.bottom_right');
        if(topLeft && bottomRight) {
          const coords = [];
          coords.push([topLeft.lon, topLeft.lat]);
          coords.push([bottomRight.lon, topLeft.lat]);
          coords.push([bottomRight.lon, bottomRight.lat]);
          coords.push([topLeft.lon, bottomRight.lat]);
          features.push({
            type: 'Polygon',
            coordinates: [coords]
          });
        }
      } else if (_.has(filter, 'geo_polygon.' + field)) {
        const points = _.get(filter, 'geo_polygon.' + field + '.points', []);
        const coords = [];
        points.forEach(function(point) {
          const lat = point[1];
          const lon = point[0];
          coords.push([lon, lat]);
        });
        if(polygon.length > 0) features.push({
            type: 'Polygon',
            coordinates: [coords]
          });
      }
      return features;
    }

    function appendMap(options) {
      var params = $scope.vis.params;
      var container = $element[0].querySelector('.tilemap');
      map = new TileMapMap(container, {
        center: options.center,
        zoom: options.zoom,
        callbacks: {
          createMarker: createMarker,
          deleteMarkers: deleteMarkers,
          mapMoveEnd: mapMoveEnd,
          mapZoomEnd: mapZoomEnd,
          polygon: polygon,
          rectangle: rectangle
        },
        mapType: params.mapType,
        tooltipFormatter: Private(require('ui/agg_response/geo_json/_tooltip_formatter')),
        valueFormatter: options.valueFormatter || _.identity,
        attr: params,
        editable: $scope.vis.getEditableVis() ? true : false
      });
    }

    function resizeArea() {
      if (map) map.updateSize();
    }

    function isGeoFilter(filter, field) {
      if (filter.meta.key === field
        || _.has(filter, 'geo_bounding_box.' + field)
        || _.has(filter, 'geo_polygon.' + field)
        || _.has(filter, 'or[0].geo_bounding_box.' + field)
        || _.has(filter, 'or[0].geo_polygon.' + field)) {
        return true;
      } else {
        return false;
      }
    }

    function filterAlias(field, numBoxes) {
      return field + ": " + numBoxes + " geo filters"
    }

    const mapMoveEnd = function (event) {
      const agg = _.get(event, 'chart.geohashGridAgg');
      if (!agg) return;

      const center = [
        _.round(event.center.lat, 5),
        _.round(event.center.lng, 5)
      ]

      const editableVis = agg.vis.getEditableVis();
      if (!editableVis) return;
      editableVis.params.mapCenter = center;
      editableVis.params.mapZoom = event.zoom;

      const editableAgg = editableVis.aggs.byId[agg.id];
      if (editableAgg) {
        editableAgg.params.mapZoom = event.zoom;
        editableAgg.params.mapCenter = center;
      }
    }

    const mapZoomEnd = function (event) {
      const agg = _.get(event, 'chart.geohashGridAgg');
      if (!agg || !agg.params.autoPrecision) return;

      agg.params.mapZoom = event.zoom;
      
      // zoomPrecision maps event.zoom to a geohash precision value
      // event.limit is the configurable max geohash precision
      // default max precision is 7, configurable up to 12
      const zoomPrecision = {
        1: 2,
        2: 2,
        3: 2,
        4: 3,
        5: 3,
        6: 4,
        7: 4,
        8: 5,
        9: 5,
        10: 6,
        11: 6,
        12: 7,
        13: 7,
        14: 8,
        15: 9,
        16: 10,
        17: 11,
        18: 12
      };

      const precision = config.get('visualization:tileMap:maxPrecision');
      agg.params.precision = Math.min(zoomPrecision[event.zoom], precision);

      courier.fetch();
    }

    const rectangle = function (event) {
      const agg = _.get(event, 'chart.geohashGridAgg');
      if (!agg) return;
      
      const indexPatternName = agg.vis.indexPattern.id;
      const field = agg.fieldName();
      
      const newFilter = {geo_bounding_box: {}};
      newFilter.geo_bounding_box[field] = event.bounds;

      addGeoFilter(newFilter, field, indexPatternName);
    }

    const polygon = function (event) {
      const agg = _.get(event, 'chart.geohashGridAgg');
      if (!agg) return;
      
      const indexPatternName = agg.vis.indexPattern.id;
      const field = agg.fieldName();
      
      const newFilter = {geo_polygon: {}};
      newFilter.geo_polygon[field] = { points: event.points};

      addGeoFilter(newFilter, field, indexPatternName);
    }

    function addGeoFilter(newFilter, field, indexPatternName) {
      let existingFilter = null;
      _.flatten([queryFilter.getAppFilters(), queryFilter.getGlobalFilters()]).forEach(function (it) {
        if (isGeoFilter(it, field)) {
          existingFilter = it;
        }
      });

      if (existingFilter) {
        let geoFilters = [newFilter];
        let type = '';
        if (_.has(existingFilter, 'or')) {
          geoFilters = geoFilters.concat(existingFilter.or);
          type = 'or';
        } else if (_.has(existingFilter, 'geo_bounding_box')) {
          geoFilters.push({geo_bounding_box: existingFilter.geo_bounding_box});
          type = 'geo_bounding_box';
        } else if (_.has(existingFilter, 'geo_polygon')) {
          geoFilters.push({geo_polygon: existingFilter.geo_polygon});
          type = 'geo_polygon';
        }
        queryFilter.updateFilter({
          model: { or : geoFilters },
          source: existingFilter,
          type: type,
          alias: filterAlias(field, geoFilters.length)
        });
      } else {
        const pushFilter = Private(require('ui/filter_bar/push_filter'))(getAppState());
        pushFilter(newFilter, false, indexPatternName);
      }
    }

    const createMarker = function (event) {
      const editableVis = $scope.vis.getEditableVis();
      if (!editableVis) return;
      const newPoint = [_.round(event.latlng.lat, 5), _.round(event.latlng.lng, 5)];
      editableVis.params.markers.push(newPoint);
    }

    const deleteMarkers = function (event) {
      const editableVis = $scope.vis.getEditableVis();
      if (!editableVis) return;

      event.deletedLayers.eachLayer(function (layer) {
        editableVis.params.markers = editableVis.params.markers.filter(function(point) {
          if(point[0] === layer._latlng.lat && point[1] === layer._latlng.lng) {
            return false;
          } else {
            return true;
          }
        });
      });
    }
  });
});
