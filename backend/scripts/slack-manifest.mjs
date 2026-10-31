const appOrigin=new URL(process.env.APP_ORIGIN || 'https://crewos.example.com').origin;
if (!appOrigin.startsWith('https://')) throw new Error('Use the public HTTPS APP_ORIGIN for the Slack manifest.');
console.log(JSON.stringify({
  display_information:{name:'CrewOS',description:'Assign work to your CrewOS employees and receive verified results.',background_color:'#183c35'},
  features:{bot_user:{display_name:'CrewOS',always_online:false},slash_commands:[{command:'/crewos',url:`${appOrigin}/api/slack/commands`,description:'Assign work, check task status, or link your account.',usage_hint:'run <employee-id> <goal> | status <task-id> | link',should_escape:false}]},
  oauth_config:{redirect_urls:[`${appOrigin}/oauth/slack/callback`],scopes:{bot:['commands','chat:write']}},
  settings:{org_deploy_enabled:false,socket_mode_enabled:false,token_rotation_enabled:false},
},null,2));
