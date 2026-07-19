'use strict';

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { Customer } = require('../models');

const serverUrl = process.env.SERVER_URL || 'http://localhost:3001';

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await Customer.findByPk(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'your-google-client-id',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'your-google-client-secret',
      callbackURL: `${serverUrl}/api/customers/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('Google profile did not include an email'), null);
        }

        let user = await Customer.findOne({ where: { email } });
        const username = profile.displayName || email.split('@')[0];

        if (!user) {
          const uniqueUsername = username.replace(/\s+/g, '').toLowerCase();
          user = await Customer.create({
            username: uniqueUsername,
            email,
            password: null,
            role: 'client',
            provider: 'google',
            providerId: profile.id,
          });
        } else {
          user.provider = 'google';
          user.providerId = profile.id;
          await user.save();
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID || 'your-facebook-app-id',
      clientSecret: process.env.FACEBOOK_APP_SECRET || 'your-facebook-app-secret',
      callbackURL: `${serverUrl}/api/customers/auth/facebook/callback`,
      profileFields: ['id', 'displayName', 'emails'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('Facebook profile did not include an email'), null);
        }

        let user = await Customer.findOne({ where: { email } });
        const username = profile.displayName || email.split('@')[0];

        if (!user) {
          const uniqueUsername = username.replace(/\s+/g, '').toLowerCase();
          user = await Customer.create({
            username: uniqueUsername,
            email,
            password: null,
            role: 'client',
            provider: 'facebook',
            providerId: profile.id,
          });
        } else {
          user.provider = 'facebook';
          user.providerId = profile.id;
          await user.save();
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);
