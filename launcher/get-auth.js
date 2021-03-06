var bot18 = global.BOT18

/*
  launcher.getWallet(cb)

  - Creates ~/.bot18 directory if it doesn't exist
  - Creates an anonymous, unencrypted Salty wallet at ~/.bot18/id_salty
      (used for verifying downloads from ZalgoNet)
  - Prompts for ZalgoNet email/password at first startup,
      requests an auth_token from ZalgoNet, and
      caches it at ~/.bot18/auth_token
  - Subsequent API calls include auth_token in headers,
      to bind to the associated user account and claimed codes.
*/

module.exports = function getAuth (cb) {
  var path = require('path')
  var r = path.resolve
  var fs = require('fs')
  var debug = require('debug')('launcher')
  var prompt = require('cli-prompt')
  var pempal = require('pempal')
  var salty = require('salty')
  var async = require('async')
  var linkify = require('linkify-terminal')
  var conf = bot18.conf
  // set up the settings dir if it doesn't exist.
  fs.stat(conf.home, function (err, stat) {
    if (err && err.code === 'ENOENT') {
      debug('Creating ~/.bot18 (chmod 0700)'.grey)
      fs.mkdir(conf.home, parseInt('0700', 8), function (err) {
        if (err) return cb(err)
        debug('Creating ~/.bot18/config.js (chmod 0600)'.grey)
        require(r(__dirname, 'save-conf'))(r(conf.home, 'config.js'), function (err) {
          if (err) return cb(err)
          debug('Creating ~/.bot18/builds (chmod 0700)'.grey)
          fs.mkdir(r(conf.home, 'builds'), parseInt('0700', 8), function (err) {
            if (err) return cb(err)
            withHome()
          })
        })
      })
    }
    else if (err) {
      return cb(err)
    }
    else {
      withHome()
    }
  })

  // Set up the local Salty wallet (ephemeral, unencrypted,
  //   used for verifying downloads from ZalgoNet)
  function withHome () {
    var id_salty_path = r(conf.home, 'id_salty')
    fs.stat(id_salty_path, function (err, stat) {
      if (err && err.code === 'ENOENT') {
        // generate a new Salty wallet.
        debug('Creating ~/.bot18/id_salty (chmod 0600)'.grey)
        bot18.wallet = salty.wallet.create()
        bot18.pubkey = bot18.wallet.pubkey
        fs.writeFile(id_salty_path, bot18.wallet.toPEM() + '\n', {mode: parseInt('0600', 8)}, function (err) {
          if (err) return cb(err)
          debug('Creating ~/.bot18/id_salty.pub (chmod 0644)'.grey)
          fs.writeFile(r(conf.home, 'id_salty.pub'), bot18.pubkey.toString() + '\n', {mode: parseInt('0644', 8)}, function (err) {
            if (err) return cb(err)
            withWallet()
          })
        })
      }
      else if (err) {
        return cb(err)
      }
      else {
        fs.readFile(id_salty_path, {encoding: 'utf8'}, function (err, id_salty) {
          if (err) return cb(err)
          try {
            var pem = pempal.decode(id_salty, {tag: 'SALTY WALLET'})
            bot18.wallet = salty.wallet.parse(pem.body)
          }
          catch (e) {
            return cb(e)
          }
          fs.readFile(r(conf.home, 'id_salty.pub'), {encoding: 'utf8'}, function (err, id_salty_pub) {
            if (err) return cb(err)
            bot18.wallet.pubkey = bot18.pubkey = salty.pubkey.parse(id_salty_pub)
            withWallet()
          })
        })
      }
    })
  }

  // Determine our auth status with ZalgoNet.
  function withWallet () {
    // Check for cached auth_token.
    fs.readFile(r(conf.home, 'auth.json'), {encoding: 'utf8'}, function (err, auth_json) {
      if (err && err.code !== 'ENOENT') {
        return cb(err)
      }
      if (auth_json) {
        // We have a cached auth_token, validate it with ZalgoNet
        try {
          bot18.auth = JSON.parse(auth_json)
          debug('Using cached auth: ~/.bot18/auth.json'.grey)
        }
        catch (e) {
          debug('Error parsing cached auth at ~/.bot18/auth.json'.red)
          return getNewAuth()
        }
        if (bot18.cmd.offline) {
          // Skip validation, avoid connection to ZalgoNet.
          return cb()
        }
        debug('Validating cached auth with ZalgoNet - Please stand by...'.grey)
        bot18.lib.mr_get('https://code.bot18.net/auth/' + bot18.auth.user_info.username, function (err, resp, body) {
          if (err) {
            return cb(new Error('Your network connection is down. Please try again later.'))
          }
          switch (resp.statusCode) {
            case 200:
              if (body && body.authorized) {
                // We good.
                bot18.auth = body
                withAuth()
              }
              else {
                cb(new Error('Unreadable response from ZalgoNet. The REST API may have changed, or your DNS may be tampered with.'))
              }
              return
            case 403:
              // Invalid or expired auth_token.
              return getNewAuth()
            case 400:
              return cb(new Error('Invalid request to ZalgoNet. The REST API may have changed.'))
            case 429:
              return cb(new Error('Your IP (' + body.request_ip + ') is making too many requests/sec to ZalgoNet. (Limit is ' + body.max_reqs_per_sec + ' reqs/sec, your reqs/sec: ' + (body.reqs_blocked + 1) + ')'))
            case 500:
            default:
              return cb(new Error('ZalgoNet is temporarily down. Please try again later.'))
          }
        })
      }
      else {
        getNewAuth()
      }
    })

    // Request ZalgoNet credentials from stdin.
    function getNewAuth () {
      debug(' ' + ' Beep Boop, This is Bot18! '.yellow.inverse)
      if (!bot18.auth) {
        debug('      I\'m performing intial setup to connect your '.yellow + 'ZalgoNet'.cyan +' account.'.yellow)
        debug('      Your information will be handled securely and encrypted whenever possible.'.yellow)
        debug('      If you don\'t have a '.yellow + 'ZalgoNet'.cyan + ' account yet, sign up at: '.yellow + linkify('https://bot18.net/register', {pretty: true}).green)
        //debug('      Here\'s a tip: enter "guest" for a 15-minute Bot18 trial!'.cyan)
      }
      else {
        debug('      Your cached auth token expired, so I\'m trying to reconnect your '.yellow + 'ZalgoNet'.cyan + ' account.'.yellow)
        debug('      Please re-enter your '.yellow + 'ZalgoNet'.cyan + ' credentials so we can authorize you:'.yellow)
      }
      console.error()
      getCreds()
    }
  }

  function getCreds () {
    ;(function promptForUsername () {
      prompt('  Username: (CTRL-C to exit)'.grey + '\n      ', function (username) {
        username = (username || '').trim()
        if (!username) {
          return promptForUsername()
        }
        if (username.toLowerCase() === 'guest') {
          return withCreds('guest', 'uNl3AsH tHe ZaLG0')
        }
        // Check if username exists.
        debug('Searching '.grey + 'ZalgoNet'.cyan + ' - Please stand by...'.grey)
        bot18.lib.mr_get('https://code.bot18.net/auth/' + username, {query: {check_username: true}}, function (err, resp, body) {
          if (err) {
            return cb(new Error('Your network connection is down. Please try again later.'))
          }
          switch (resp.statusCode) {
            case 200:
              if (body && body.exists === true) {
                // Username is ok.
                debug('Username '.grey + body.username.yellow + ' found.'.green)
                return setTimeout(promptForPassword, 0)
                break
              }
              else {
                debug('Username '.grey + username.yellow + ' not found!'.red)
                return setTimeout(promptForUsername, 0)
              }
            case 429:
              return cb(new Error('Your IP (' + body.request_ip + ') is making too many requests/sec to ZalgoNet. (Limit is ' + body.max_reqs_per_sec + ' reqs/sec, your reqs/sec: ' + (body.reqs_blocked + 1) + ')'))
            case 500:
            default:
              // Server Error.
              return cb(new Error('ZalgoNet is temporarily down. Please try again later.'))
          }
          function promptForPassword () {
            prompt.password('  Password:'.grey + '\n      ', function (password) {
              password = (password || '').trim()
              if (!password) {
                return promptForPassword()
              }
              withCreds(username, password)
            })
          }
        })
      })
    })()
  }

  // Log into ZalgoNet using username/password.
  function withCreds (username, password) {
    var opts = {
      data: {
        password: password,
        pubkey: bot18.pubkey.pubkey
      },
      headers: {
        'user-agent': 'bot18/' + process.env.BOT18_LAUNCHER_VERSION
      }
    }
    debug('Authenticating - Please stand by...'.grey)
    bot18.lib.mr_post('https://code.bot18.net/auth/' + username, opts, function (err, resp, body) {
      if (err) {
        return cb(new Error('Your network connection is down. Please try again later.'))
      }
      switch (resp.statusCode) {
        case 200:
          if (body && body.authorized) {
            // We good.
            bot18.auth = body
            withAuth()
          }
          else {
            cb(new Error('Unreadable response from ZalgoNet. The REST API may have changed, or your DNS may be tampered with.'))
          }
          return
        case 403:
          // Bad password.
          debug('Bad password.'.red)
          return getCreds()
        case 400:
          return cb(new Error('Invalid request to ZalgoNet. The REST API may have changed.'))
        case 429:
          return cb(new Error('Your IP (' + body.request_ip + ') is making too many requests/sec to ZalgoNet. (Limit is ' + body.max_reqs_per_sec + ' reqs/sec, your reqs/sec: ' + (body.reqs_blocked + 1) + ')'))  
        case 500:
        default:
          return cb(new Error('ZalgoNet is temporarily down. Please try again later.'))
      }
    })
  }

  function withAuth () {
    debug('Success!'.green + ' You are logged into '.grey + 'ZalgoNet'.cyan + ' as: '.grey + bot18.auth.user_info.username.yellow)
    debug('Updating ~/.bot18/auth.json (chmod 0600)'.grey)
    fs.writeFile(r(conf.home, 'auth.json'), JSON.stringify(bot18.auth, null, 2), {encoding: 'utf8', mode: parseInt('0600', 8)}, function (err) {
      if (err) return cb(err)
      cb()
    })
  }
}