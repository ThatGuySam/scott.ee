import Axios from 'axios'
import Cache from 'node-persist'
import fs from 'fs'
import ef from 'empty-folder'
import getTmpDir from './getTmpDir'

const debug = require( 'debug' )( 'nuxt:generate' )
const cacheDir = getTmpDir()

// https://stackoverflow.com/a/21196961/1397641
function ensureExists(path, mask, cb) {
    if (typeof mask == 'function') { // allow the `mask` parameter to be optional
        cb = mask
        mask = '0777'
    }
    fs.mkdir(path, mask, function(err) {
        if (err) {
            if (err.code == 'EEXIST') cb(null); // ignore the error if the folder already exists
            else cb(err) // something else went wrong
        } else cb(null) // successfully created folder
    })
}

// Ensure that our cache directory exists
ensureExists(cacheDir, '0744', function(err) {
	if (err) console.error(err)
})

// Set up cache
const cache = Cache.create( { dir: cacheDir, ttl: 300000 } )

module.exports = function () {
	// Add hook for generate before to cache the API
	this.nuxt.hook('generate:before', async ( generator ) => {
		const routes = async () => {
			const apiRoutes = []
			const axios = Axios.create( { baseURL: generator.nuxt.options.axios.baseURL } )

			// function to query for posts or total pages of a post type
			const postTypeQuery = async ( postType, page = 1, getTotal = false ) => {
				const result = await axios.get( '?_embed', { params: {
					'rest_route': `/wp/v2/${postType}`,
					'per_page': generator.nuxt.options.wordpress.postsPerPage,
					'page': page
				} } )

				if ( getTotal ) {
					return result.headers['x-wp-totalpages']
				} else {
					result.data.postType = postType
					result.data.page = page
					result.data.totalPosts = result.headers['x-wp-total']
					result.data.totalPostsPages = result.headers['x-wp-totalpages']
					return result.data
				}
			}

			// function to generate promises for a post type
			const postTypePromises = async ( postType ) => {
				const promises = []
				const totalPostType = await postTypeQuery( postType, 1, true )
				const pages = Array.from( { length: totalPostType }, ( v, k ) => k + 1 );

				for ( const page of pages ) {
					promises.push( await postTypeQuery( postType, page ) )
				}
				return promises;
			}

			// loop through the post types and generate promises
			const promises = generator.nuxt.options.wordpress.postTypes.map( async ( postType ) => {
				return await postTypePromises( postType )
			} )

			// check cache first
			let apiRoutesReturn = await cache.getItem( 'routes' )

			// no cache generate from API
			if ( apiRoutesReturn === undefined ) {
				debug( 'Caching API' )

				ensureExists(generator.nuxt.options.generate.apiCacheDir, '0744', function(err) {
					if (err) console.error(err)
				})
				// empty cache dir
				ef( generator.nuxt.options.generate.apiCacheDir, false, ( feedback ) => {
					if ( ! feedback.error ) {
						debug( 'Stale API cache removed' )
					}
				} )
				// once all promises are complete, generate the routes
				await Promise.all( promises ).then( ( data ) => {
					const flatData = data.reduce( ( a, b ) => a.concat( b ), [] )
					flatData.map( ( result ) => {
						// grab route info from results
						const postType = result.postType
						const page = parseInt( result.page )
						const totalPosts = parseInt( result.totalPosts )
						const totalPostsPages = parseInt( result.totalPostsPages )

						// pagination
						if ( 'posts' === postType ) {
							// meta data is added to the response and later used to fake API responses
							const data = {
								payload: result,
								meta: {
									page,
									totalPosts,
									totalPostsPages
								}
							}

							// write this result to a local JSON store
							// to completely skip the API in production, the cahced result is intercepted
							// as part of an axios api request (see plugins/axios.js )
							fs.writeFile( generator.nuxt.options.generate.apiCacheDir + 'page-' + page + '.json', JSON.stringify( data ), ( err ) => {
								if ( err ) throw err;
							} )

							apiRoutes.push( {
								route: ( 1 === page ) ? '/' : '/page/' + page,
								payload: data
							} )
						}

						// individual posts
						result.map( ( post ) => {
							post.page = page

							// write result to local JSON store
							fs.writeFile( generator.nuxt.options.generate.apiCacheDir + post.slug + '.json', JSON.stringify( [ post ] ) , ( err ) => {
								if ( err ) throw err;
							} )

							apiRoutes.push( {
								route: ( 'posts' === postType ) ? '/journal/' + post.slug : '/' + post.slug,
								payload: post
							} )
						} )
					} )
				} )

				// cache set
				cache.setItem( 'routes', apiRoutes )
				debug( 'New API cache created' )
			} else {
				debug( 'Using API cache' )
			}
		}
		await routes()
	} )
}
