import test from 'node:test'
import assert from 'node:assert/strict'
import {validTaskIntent,taskSections} from '../src/navigation.ts'
import {entryLocation,navigationUrl,notificationNavigation} from '../src/notification-navigation.ts'
test('all six task sections survive deep-link refresh with exact weekly identity',()=>{
 for(const section of taskSections){const intent={id:'task_1',targetType:'task' as const,section,weeklyRecordId:'week_1'};assert.deepEqual(entryLocation(new URL(navigationUrl('work-register',intent),'https://example.test')),{page:'work-register',intent})}
})
test('untrusted deep-link section and malformed object IDs are discarded',()=>{
 assert.deepEqual(entryLocation({pathname:'/work',search:'?view=work-register&id=https://evil&section=delete&weeklyRecordId=../../private&targetType=task'}),{page:'work-register',intent:{targetType:'task'}})
 assert.equal(validTaskIntent({taskId:'../private'}),null)
 assert.equal(validTaskIntent({taskId:'task_1',section:'destroy' as never})?.section,'overview')
})
test('task notifications and minimal support notifications use unified destinations',()=>{
 assert.deepEqual(notificationNavigation({type:'task',id:'task_1'}),{page:'work-register',intent:{id:'task_1',targetType:'task',section:'overview'}})
 assert.deepEqual(notificationNavigation({type:'blocker',id:'blocker_1'}),{page:'collaboration',intent:{id:'blocker_1',targetType:'blocker'}})
})
