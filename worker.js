var async = require('async');
var rest = require('restler');
var _ = require('underscore');
var redis = require('redis');
var marked = require('marked');
var Engine = require('./lib/engine');

var config = require('./config');
var db = require('./db');

var Agency = require('mongoose-agency');
var agency = new Agency( db.source );

var engine = new Engine();

Page         = require('./models/Page').Page;
Person       = require('./models/Person').Person;
Post         = require('./models/Post').Post;

engine.init('martindale', function() {
  agency.subscribe( 'multi' , jobProcessor );
});

var jobProcessor = function(job, done) {
  console.log('processing job...');
  switch (job.type) {
    default:
      console.log('unknown job type "'+ job.type +'", calling done()...');
      done();
    break;
    case 'process:twitter:tweet':
      var tweet = job.data;
      engine.processTweet( job.data , function(err) {
        /*/engine.providers.twitter.getTimeline('mentions_timeline', {
            //all: true,
            oldestID: bigint( tweet.id_str )
        }, function(err, replies) {
          if (err) { console.log(err); }
          if (replies) {
            console.log(replies.length + ' replies found')
            replies.forEach(function(reply) {
              if (reply.in_reply_to_status_id_str == tweet.id_str) {
                reply.inReplyTo = {
                    id: tweet.id_str
                  , uri: 'http://twitter.com/' + tweet.user.screen_name + '/status/' + tweet.id_str
                }
                engine.processTweet( reply , function(err) {

                });
              }
            });
          }
        }); /**/

        engine.providers.twitter.get('statuses/retweets/' + tweet.id_str , function(err, retweets) {
          if (retweets) {
            retweets.forEach(function(retweet) {
              agency.publish('multi', {
                  type: 'process:twitter:tweet'
                , data: retweet
              }, function(err) {
                if (err) console.error( err );
              });
            });
          }
          done( err );
        });
      });
    break;
    case 'process:google:comment':
      engine.processGoogleComment( job.data , done );
    break;
    case 'process:google:post':
      engine.processGooglePost( job.data , function(err) {
        agency.publish('multi', {
            type: 'sync:google:comments'
          , data: job.data
        }, function(err) {
          if (err) console.error( err );
        });
        done(err);
      });
    break;
    case 'sync:google:comments':
      var activity = job.data;
      engine.providers.google.get('activities/'+activity.id+'/comments', function(err, results) {
        if (results.items) {
          results.items.forEach(function(comment) {
            agency.publish('multi', {
                type: 'process:google:comment'
              , data: comment
            }, function(err) {
              if (err) console.error( err );
            });
          });
        }
        done( err );
      });
    break;
    case 'process:facebook:post':
      var item = job.data;
      engine.processFacebookPost( item , function(err) {
        if (item.comments) {
          item.comments.data.forEach(function(comment) {
            // modify Facebook's nested data structure to add parent data
            comment.inReplyTo = {
                id: item.id
              , uri: 'https://www.facebook.com/'+item.from.id+'/posts/'+item.id
            };
            agency.publish('multi', {
                type: 'process:facebook:post'
              , data: comment
            }, function(err) {
              if (err) console.error( err );
            });
          });
        }
        done(err);
      });
    break;
    case 'sync:facebook':
      engine.providers.facebook.get('eric.martindale/feed', {
          limit: 200
        , all: true
      }, function(err, data) {
        if (err) {
          console.error(err);
          return done(err);
        }
        
        console.log(data);

        async.each( data.data , function(item, itemComplete) {
          console.log('item:', item);
          agency.publish('multi', {
              type: 'process:facebook:post'
            , data: item
          }, itemComplete );
        }, done );

      });
    break;
    case 'sync:twitter':
      var bigint = require('bigint');
      engine.providers.twitter.getTimeline('user_timeline', {
        //all: true
      }, function(err, tweets) {
        if (err) { return done(err); }
        tweets.forEach(function(tweet) {
          agency.publish('multi', {
              type: 'process:twitter:tweet'
            , data: tweet
          }, function(err) {
            if (err) console.error( err );
          });
        });
        done(err);
      });
    break;
    case 'sync:google':
      engine.providers.google.getActivities( undefined , function(activities) {
        activities.forEach(function(activity) {
          agency.publish('multi', {
              type: 'process:google:post'
            , data: activity
          }, function(err) {
            if (err) console.error( err );
          });
        });
        done();
      });
    break;
    case 'sync:custom':
      rest.get('http://old.ericmartindale.com/export.php').on('complete', function(data) {

        if (!data.pages) { data.pages = []; }
        if (!data.posts) { data.posts = []; }

        console.log(_.toArray(data.posts).length + ' posts found, ');
        console.log(_.toArray(data.pages).length + ' pages found, ');

        _.toArray(data.pages).forEach(function(oldPage) {
          Page.findOne({ slug: oldPage.url }).exec(function(err, page) {
            if (!page) { var page = new Page({}); }

            page.title = oldPage.title;
            page.content = new Buffer( oldPage.body || '' , 'hex' ).toString('utf8');
            page.save(function(err) {
              console.log('page saved!');
            })
          });
        });

        var yaml = require('js-yaml');

        _.toArray(data.posts).forEach(function(oldPost) {

          var tempPost = new Post({
              title: oldPost.url
            , published: new Date(oldPost.created_at)
            , slug: oldPost.url
          });
          var urlKey = 'http://www.ericmartindale.com' + tempPost.permalink;
          console.log('urlKey: ' + urlKey)
          console.log('tempPost:')
          console.log(tempPost)

          //process.exit();

          Post.findOne({ 'resources.uri': urlKey }).exec(function(err, post) {
            if (!post) { var post = new Post({}); }

            var pureTags = new Buffer( oldPost.tags || '' , 'hex' ).toString('utf8');
            // TODO: js-yaml, but without exceptions
            try { // yuck.  I'm sorry.
              var tags = JSON.parse(JSON.stringify( yaml.load( pureTags ) ) );
              if (tags) {
                post.tags = (typeof(tags) == 'object') ? Object.keys( tags ) : [];
              }
            } catch (e) { }

            post._author = engine._author;

            post.slug = oldPost.url;
            post.title = oldPost.title;
            post.content = new Buffer( oldPost.content || '' , 'hex' ).toString('utf8');
            post.published = new Date(oldPost.created_at);
            post.updated = new Date(oldPost.updated_at);

            post.content = marked(post.content);

            var resourceMap = {};
            post.resources.forEach(function(resource) {
              resourceMap[ resource.uri ] = resource;
            });
            if (Object.keys( resourceMap ).indexOf( urlKey ) == -1) {
              post.resources.push({
                  uri: urlKey
                , data: oldPost
              });
            }
            if (post.slugs.indexOf( oldPost.url ) == -1) { post.slugs.push( oldPost.url ); }

            post.save(function(err) {
              if (err) { console.log(err); }
              console.log('post saved!');
              done();
            })
          });
        });

      });
    break;
  }
};
